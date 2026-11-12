const { body, param, query: q } = require('express-validator');
const { query } = require('../config/db');
const config = require('../config/env');
const { httpError } = require('../middleware/error');
const { publicUser, parseCv } = require('../utils/token');
const { escapeLike, pagination, profileSegments } = require('../utils/text');
const recommendation = require('../services/recommendation');

const idParam = param('id').isInt({ min: 1 }).withMessage('Identifiant invalide.').toInt();

const listRules = [
  q('q').optional().isString().isLength({ max: 100 }),
  q('city').optional().isString().isLength({ max: 120 })
];

const updateMeRules = [
  body('firstName').optional().trim().isLength({ min: 2, max: 80 }).withMessage('Prénom : 2 à 80 caractères.'),
  body('lastName').optional().trim().isLength({ min: 2, max: 80 }).withMessage('Nom : 2 à 80 caractères.'),
  body('city').optional({ values: 'null' }).isString().trim().isLength({ max: 120 }).withMessage('Ville trop longue.'),
  body('bio').optional({ values: 'null' }).isString().trim().isLength({ max: 2000 }).withMessage('Bio trop longue (2000 max).'),
  body('avatarUrl')
    .optional({ values: 'falsy' })
    .isString()
    .isLength({ max: 3_000_000 })
    .withMessage('Photo trop volumineuse.')
    .matches(/^(data:image\/(png|jpe?g|webp|gif);base64,|https?:\/\/)/)
    .withMessage('Format de photo invalide.'),
  body('cvData').optional({ values: 'null' }).custom((v) => typeof v === 'object').withMessage('CV invalide.')
];

const addSkillRules = [
  body('skillId').isInt({ min: 1 }).withMessage('Compétence invalide.').toInt(),
  body('type').isIn(['offer', 'need']).withMessage('Type de compétence invalide (offer ou need).'),
  body('level').optional().isIn(['beginner', 'intermediate', 'expert']).withMessage('Niveau invalide.'),
  body('description').optional({ values: 'falsy' }).isString().trim().isLength({ max: 500 }).withMessage('Description trop longue.')
];

function publicMini(user) {
  return {
    id: user.id,
    firstName: user.first_name,
    lastName: user.last_name,
    city: user.city,
    bio: user.bio,
    avatarUrl: user.avatar_url,
    cvData: parseCv(user.cv_data),
    rating: user.rating ? Number(user.rating) : null,
    createdAt: user.created_at
  };
}

// Annuaire : recherche par nom, bio OU compétence ; paginé. Si le ml-service est actif, la recherche
// est aussi « sémantique » : « dessiner » trouve les membres qui offrent Illustration ou Design.
async function listPublicUsers(req, res) {
  const text = (req.query.q || '').trim();
  const term = `%${escapeLike(text)}%`;
  const city = req.query.city ? `%${escapeLike(req.query.city.trim())}%` : '%';
  const { page, limit, offset } = pagination(req.query, { defaultLimit: 50, maxLimit: 100 });

  let related = [];
  if (config.ml.url && text.length >= 3) {
    const catalog = await query('SELECT id, name FROM skills');
    const found = await recommendation.searchSkills(text, catalog);
    related = (found || []).filter((r) => Number.isInteger(r.skillId));
  }
  const semanticClause = related.length
    ? `OR EXISTS (SELECT 1 FROM user_skills us3 WHERE us3.user_id = u.id AND us3.skill_id IN (?))`
    : '';

  const where = `u.role = 'user' AND u.is_active = 1 AND u.id != ?
    AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.bio LIKE ?
         OR EXISTS (SELECT 1 FROM user_skills us2 JOIN skills s2 ON s2.id = us2.skill_id
                    WHERE us2.user_id = u.id AND s2.name LIKE ?)
         ${semanticClause})
    AND (u.city LIKE ? OR (? = '%' AND u.city IS NULL))`;
  const params = [req.user.id, term, term, term, term, ...(related.length ? [related.map((r) => r.skillId)] : []), city, city];

  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM users u WHERE ${where}`, params);
  const users = await query(
    `SELECT u.id, u.first_name, u.last_name, u.city, u.bio, u.avatar_url, u.cv_data, u.created_at,
            (SELECT ROUND(AVG(r.rating), 1) FROM reviews r WHERE r.reviewee_id = u.id) AS rating
     FROM users u WHERE ${where}
     ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  const byUser = new Map(users.map((u) => [u.id, { ...publicMini(u), skills: [] }]));
  if (users.length) {
    const skills = await query(
      `SELECT us.user_id, us.id, us.type, us.level, us.description, s.name AS skillName, c.name AS categoryName
       FROM user_skills us
       JOIN skills s ON s.id = us.skill_id
       JOIN categories c ON c.id = s.category_id
       WHERE us.user_id IN (?)`,
      [users.map((u) => u.id)]
    );
    skills.forEach((s) => byUser.get(s.user_id)?.skills.push(s));
  }
  res.json({
    users: [...byUser.values()],
    meta: { page, limit, total, ...(related.length ? { semantic: related.map((r) => r.name) } : {}) }
  });
}

async function getPublicUser(req, res) {
  const rows = await query(
    `SELECT u.*, (SELECT ROUND(AVG(r.rating), 1) FROM reviews r WHERE r.reviewee_id = u.id) AS rating
     FROM users u WHERE u.id = ? AND u.role = 'user' AND u.is_active = 1`,
    [req.params.id]
  );
  if (!rows.length) throw httpError(404, 'Profil introuvable.');
  const skills = await query(
    `SELECT us.*, s.name AS skillName, c.name AS categoryName
     FROM user_skills us
     JOIN skills s ON s.id = us.skill_id
     JOIN categories c ON c.id = s.category_id
     WHERE us.user_id = ?`,
    [req.params.id]
  );
  const reviews = await query(
    `SELECT r.id, r.rating, r.comment, r.created_at, u.first_name, u.last_name
     FROM reviews r JOIN users u ON u.id = r.reviewer_id
     WHERE r.reviewee_id = ? ORDER BY r.created_at DESC LIMIT 20`,
    [req.params.id]
  );
  res.json({ user: { ...publicMini(rows[0]), skills, reviews } });
}

// Mise à jour partielle : seuls les champs envoyés sont modifiés.
async function updateMe(req, res) {
  const b = req.body;
  const sets = [];
  const values = [];
  const add = (column, value) => {
    sets.push(`${column} = ?`);
    values.push(value);
  };
  if (b.firstName !== undefined) add('first_name', b.firstName);
  if (b.lastName !== undefined) add('last_name', b.lastName);
  if (b.city !== undefined) add('city', b.city || null);
  if (b.bio !== undefined) add('bio', b.bio || null);
  if (b.avatarUrl !== undefined) add('avatar_url', b.avatarUrl || null);
  if (b.cvData !== undefined && b.cvData !== null) add('cv_data', JSON.stringify(b.cvData));

  if (sets.length) {
    await query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...values, req.user.id]);
  }
  const rows = await query('SELECT * FROM users WHERE id = ?', [req.user.id]);
  res.json({ user: publicUser(rows[0]) });
}

async function mySkills(req, res) {
  const rows = await query(
    `SELECT us.*, s.name AS skillName, c.id AS categoryId, c.name AS categoryName
     FROM user_skills us
     JOIN skills s ON s.id = us.skill_id
     JOIN categories c ON c.id = s.category_id
     WHERE us.user_id = ?
     ORDER BY us.type, s.name`,
    [req.user.id]
  );
  res.json({ skills: rows });
}

// Suggestions de compétences à ajouter, déduites de la bio et du CV (ml-service). Bonus : jamais d'erreur 5xx si l'IA est absente.
async function skillSuggestions(req, res) {
  if (!config.ml.url) return res.json({ available: false, reason: 'disabled', suggestions: [] });
  const [me] = await query('SELECT bio, cv_data FROM users WHERE id = ?', [req.user.id]);
  const segments = profileSegments(me?.bio, parseCv(me?.cv_data));
  if (!segments.length) return res.json({ available: true, reason: 'no_text', suggestions: [] });

  const [catalog, owned] = await Promise.all([
    query('SELECT s.id, s.name, c.name AS categoryName FROM skills s JOIN categories c ON c.id = s.category_id'),
    query('SELECT DISTINCT skill_id FROM user_skills WHERE user_id = ?', [req.user.id])
  ]);
  const found = await recommendation.suggestSkills(segments, catalog, owned.map((r) => r.skill_id));
  if (found === null) return res.json({ available: false, reason: 'unavailable', suggestions: [] });

  const category = new Map(catalog.map((s) => [s.id, s.categoryName]));
  res.json({
    available: true,
    suggestions: found
      .filter((r) => Number.isInteger(r.skillId))
      .map((r) => ({ skillId: r.skillId, name: r.name, categoryName: category.get(r.skillId) || null, score: r.score, evidence: r.evidence }))
  });
}

async function addSkill(req, res) {
  const { skillId, type, level, description } = req.body;
  await query(
    `INSERT INTO user_skills (user_id, skill_id, type, level, description)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE level = VALUES(level), description = VALUES(description)`,
    [req.user.id, skillId, type, level || 'intermediate', description || null]
  );
  res.status(201).json({ message: 'Compétence enregistrée.' });
}

async function removeSkill(req, res) {
  const result = await query('DELETE FROM user_skills WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!result.affectedRows) throw httpError(404, 'Compétence introuvable.');
  res.json({ message: 'Compétence retirée.' });
}

module.exports = {
  idParam,
  listRules,
  updateMeRules,
  addSkillRules,
  listPublicUsers,
  getPublicUser,
  updateMe,
  mySkills,
  skillSuggestions,
  addSkill,
  removeSkill
};
