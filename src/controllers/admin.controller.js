const bcrypt = require('bcryptjs');
const { body, param, query: q } = require('express-validator');
const { query, pool } = require('../config/db');
const config = require('../config/env');
// Appels via l'objet module pour pouvoir les remplacer dans les tests.
const recommendation = require('../services/recommendation');
const { httpError } = require('../middleware/error');
const { publicUser } = require('../utils/token');
const { audit } = require('../utils/audit');
const { escapeLike, slugify, pagination } = require('../utils/text');
const { STATUSES } = require('../domain/exchangeStatus');

const idParam = param('id').isInt({ min: 1 }).withMessage('Identifiant invalide.').toInt();

const listUsersRules = [
  q('q').optional().isString().isLength({ max: 100 }),
  q('role').optional().isIn(['user', 'admin'])
];
const listExchangesRules = [q('status').optional().isIn(STATUSES)];
const duplicatesRules = [q('threshold').optional().isFloat({ min: 0.6, max: 0.99 }).withMessage('threshold : 0,6 à 0,99.').toFloat()];
const mergeSkillsRules = [
  body('keepId').isInt({ min: 1 }).withMessage('Compétence à conserver invalide.').toInt(),
  body('mergeIds').isArray({ min: 1, max: 20 }).withMessage('Choisissez 1 à 20 compétences à fusionner.'),
  body('mergeIds.*').isInt({ min: 1 }).withMessage('Identifiant invalide.').toInt()
];
const matchingStatsRules = [q('days').optional().isInt({ min: 1, max: 365 }).withMessage('days : 1 à 365.').toInt()];

const updateUserRules = [
  idParam,
  body('role').optional().isIn(['user', 'admin']).withMessage('Rôle invalide.'),
  body('isActive').optional().isBoolean({ strict: true }).withMessage('isActive doit être un booléen.'),
  body('firstName').optional().trim().isLength({ min: 2, max: 80 }),
  body('lastName').optional().trim().isLength({ min: 2, max: 80 }),
  body('city').optional().trim().isLength({ max: 120 })
];
const createAdminRules = [
  body('firstName').trim().isLength({ min: 2, max: 80 }).withMessage('Prénom : 2 à 80 caractères.'),
  body('lastName').trim().isLength({ min: 2, max: 80 }).withMessage('Nom : 2 à 80 caractères.'),
  body('email').isEmail().withMessage('Email invalide.').normalizeEmail(),
  body('password')
    .isLength({ min: 10, max: 72 })
    .withMessage('Mot de passe admin : 10 caractères minimum.')
    .matches(/[A-Za-z]/)
    .matches(/\d/)
    .withMessage('Le mot de passe doit contenir lettres et chiffres.')
];
const categoryRules = [
  body('name').trim().isLength({ min: 2, max: 80 }).withMessage('Nom de catégorie : 2 à 80 caractères.'),
  body('slug').optional({ values: 'falsy' }).trim().isLength({ max: 80 }),
  body('icon').optional({ values: 'falsy' }).trim().isLength({ max: 16 })
];
const skillRules = [body('name').trim().isLength({ min: 2, max: 120 }).withMessage('Nom de compétence : 2 à 120 caractères.')];

async function dashboard(_req, res) {
  const [stats] = await query(
    `SELECT
      (SELECT COUNT(*) FROM users WHERE role = 'user') AS totalUsers,
      (SELECT COUNT(*) FROM users WHERE role = 'user' AND is_active = 1) AS activeUsers,
      (SELECT COUNT(*) FROM exchanges) AS totalExchanges,
      (SELECT COUNT(*) FROM exchanges WHERE status = 'pending') AS pendingExchanges,
      (SELECT COUNT(*) FROM exchanges WHERE status = 'completed') AS completedExchanges,
      (SELECT COUNT(*) FROM user_skills) AS listedSkills,
      (SELECT ROUND(AVG(rating), 1) FROM reviews) AS avgRating`
  );
  const recent = await query(
    `SELECT e.id, e.status, e.created_at, ru.first_name AS rfirst, ru.last_name AS rlast,
            pu.first_name AS pfirst, pu.last_name AS plast
     FROM exchanges e
     JOIN users ru ON ru.id = e.requester_id
     JOIN users pu ON pu.id = e.partner_id
     WHERE e.created_at >= (NOW() - INTERVAL 7 DAY)
     ORDER BY e.created_at DESC
     LIMIT 500`
  );
  res.json({ stats, recent });
}

async function listUsers(req, res) {
  const { page, limit, offset } = pagination(req.query, { defaultLimit: 100, maxLimit: 200 });
  const term = `%${escapeLike((req.query.q || '').trim())}%`;
  const roleFilter = req.query.role || null;
  const where = `(first_name LIKE ? OR last_name LIKE ? OR email LIKE ?) AND (? IS NULL OR role = ?)`;
  const params = [term, term, term, roleFilter, roleFilter];

  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM users WHERE ${where}`, params);
  const rows = await query(
    `SELECT id, first_name, last_name, email, role, city, is_active, created_at
     FROM users WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  res.json({ users: rows.map(publicUser), meta: { page, limit, total } });
}

async function updateUser(req, res) {
  const { role, isActive, firstName, lastName, city } = req.body;
  const id = req.params.id;
  if (id === req.user.id && ((role && role !== 'admin') || isActive === false)) {
    throw httpError(422, 'Vous ne pouvez pas retirer votre propre rôle admin ni désactiver votre compte.');
  }
  const result = await query(
    `UPDATE users SET role = COALESCE(?, role), is_active = COALESCE(?, is_active),
      first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name), city = COALESCE(?, city)
     WHERE id = ?`,
    [role || null, typeof isActive === 'boolean' ? (isActive ? 1 : 0) : null, firstName || null, lastName || null, city || null, id]
  );
  if (!result.affectedRows) throw httpError(404, 'Utilisateur introuvable.');
  await audit(req.user.id, 'user.update', 'user', id, { role, isActive, firstName, lastName, city });
  const rows = await query('SELECT * FROM users WHERE id = ?', [id]);
  res.json({ user: publicUser(rows[0]) });
}

async function createCategory(req, res) {
  const { name, slug, icon } = req.body;
  const result = await query('INSERT INTO categories (name, slug, icon) VALUES (?, ?, ?)', [
    name,
    slugify(slug || name),
    icon || '✦'
  ]);
  await audit(req.user.id, 'category.create', 'category', result.insertId, { name });
  res.status(201).json({ id: result.insertId });
}

// Catalogue plat : les nouvelles compétences vont dans la catégorie "Nouvelles compétences".
async function getOrCreateDefaultCategoryId() {
  const rows = await query("SELECT id FROM categories WHERE slug = 'nouvelles-competences' LIMIT 1");
  if (rows.length) return rows[0].id;
  const result = await query(
    "INSERT INTO categories (name, slug, icon) VALUES ('Nouvelles compétences', 'nouvelles-competences', '✨')"
  );
  return result.insertId;
}

async function createSkill(req, res) {
  const categoryId = await getOrCreateDefaultCategoryId();
  const result = await query('INSERT INTO skills (category_id, name) VALUES (?, ?)', [categoryId, req.body.name]);
  await audit(req.user.id, 'skill.create', 'skill', result.insertId, { name: req.body.name });
  res.status(201).json({ id: result.insertId });
}

async function deleteSkill(req, res) {
  const result = await query('DELETE FROM skills WHERE id = ?', [req.params.id]);
  if (!result.affectedRows) throw httpError(404, 'Compétence introuvable.');
  await audit(req.user.id, 'skill.delete', 'skill', req.params.id);
  res.json({ message: 'Compétence supprimée du catalogue.' });
}

async function listExchanges(req, res) {
  const status = req.query.status || null;
  const rows = await query(
    `SELECT e.*, ru.email AS requester_email, pu.email AS partner_email,
            ru.first_name AS rfirst, ru.last_name AS rlast,
            pu.first_name AS pfirst, pu.last_name AS plast
     FROM exchanges e
     JOIN users ru ON ru.id = e.requester_id
     JOIN users pu ON pu.id = e.partner_id
     WHERE (? IS NULL OR e.status = ?)
     ORDER BY e.created_at DESC
     LIMIT 1000`,
    [status, status]
  );
  res.json({ exchanges: rows });
}

async function createAdmin(req, res) {
  const { firstName, lastName, email, password } = req.body;
  const hash = await bcrypt.hash(password, 10);
  const result = await query(
    `INSERT INTO users (first_name, last_name, email, password_hash, role) VALUES (?, ?, ?, ?, 'admin')`,
    [firstName, lastName, email, hash]
  );
  await audit(req.user.id, 'admin.create', 'user', result.insertId, { email });
  res.status(201).json({ id: result.insertId });
}

async function listAuditLogs(_req, res) {
  const rows = await query(
    `SELECT a.id, a.action, a.target_type AS targetType, a.target_id AS targetId, a.details, a.created_at AS createdAt,
            u.first_name AS adminFirstName, u.last_name AS adminLastName
     FROM audit_logs a LEFT JOIN users u ON u.id = a.admin_id
     ORDER BY a.id DESC LIMIT 200`
  );
  res.json({ logs: rows });
}

// --- Catalogue : doublons détectés par l'IA et fusion ----------------------------------------
// GET /api/admin/catalog-duplicates?threshold=0.8 → groupes de compétences qui semblent identiques.
async function catalogDuplicates(req, res) {
  const threshold = req.query.threshold || 0.8;
  const rows = await query(
    `SELECT s.id, s.name, COUNT(us.id) AS uses
     FROM skills s LEFT JOIN user_skills us ON us.skill_id = s.id
     GROUP BY s.id, s.name ORDER BY s.name`
  );
  const clusters = await recommendation.findDuplicates(rows, threshold);
  if (clusters === null) return res.json({ available: false, threshold, clusters: [] });

  const byId = new Map(rows.map((r) => [r.id, r]));
  res.json({
    available: true,
    threshold,
    clusters: clusters.map((c) => {
      const skills = c.skills
        .map((s) => byId.get(s.skillId))
        .filter(Boolean)
        .map((s) => ({ id: s.id, name: s.name, uses: Number(s.uses) }))
        .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));
      return { score: c.score, skills };
    })
  });
}

// POST /api/admin/skills/merge { keepId, mergeIds } → les membres qui avaient une compétence fusionnée
// passent sur celle conservée ; les échanges déjà créés suivent. Une seule transaction : tout ou rien.
async function mergeSkills(req, res) {
  const { keepId } = req.body;
  const ids = [...new Set(req.body.mergeIds)].filter((id) => id !== keepId);
  if (!ids.length) throw httpError(422, 'Aucune compétence à fusionner.');
  const found = await query('SELECT id FROM skills WHERE id IN (?)', [[keepId, ...ids]]);
  if (found.length !== ids.length + 1) throw httpError(404, 'Compétence introuvable.');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const id of ids) {
      // 1. Le membre a déjà la compétence conservée (même type) : ses échanges pointent vers celle-ci.
      for (const col of ['offered_user_skill_id', 'requested_user_skill_id']) {
        await conn.query(
          `UPDATE exchanges e
           JOIN user_skills d ON e.${col} = d.id
           JOIN user_skills k ON k.user_id = d.user_id AND k.type = d.type AND k.skill_id = ?
           SET e.${col} = k.id
           WHERE d.skill_id = ?`,
          [keepId, id]
        );
      }
      // 2. Les autres lignes passent simplement sur la compétence conservée (IGNORE : les doublons restent).
      await conn.query('UPDATE IGNORE user_skills SET skill_id = ? WHERE skill_id = ?', [keepId, id]);
      // 3. La compétence fusionnée disparaît (ses lignes restantes, déjà dupliquées, partent avec elle).
      await conn.query('DELETE FROM skills WHERE id = ?', [id]);
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  await audit(req.user.id, 'skill.merge', 'skill', keepId, { merged: ids });
  res.json({ merged: ids.length, message: `${ids.length} compétence(s) fusionnée(s).` });
}

// --- Statistiques du Matching IA -------------------------------------------------------------
const pairOf = (type) =>
  `COUNT(DISTINCT CASE WHEN event_type = '${type}' THEN CONCAT(user_id, '-', candidate_id) END)`;
const rate = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

async function mlHealth() {
  if (!config.ml.url) return { configured: false, up: false, model: null };
  try {
    const res = await fetch(`${config.ml.url}/health`, { signal: AbortSignal.timeout(2000) });
    const data = res.ok ? await res.json() : null;
    return { configured: true, up: Boolean(data?.ok), model: data?.model ?? null };
  } catch {
    return { configured: true, up: false, model: null };
  }
}

// GET /api/admin/matching-stats?days=30
// Entonnoir : recommandations vues → profils ouverts → échanges proposés (en paires membre/candidat uniques,
// car la même recommandation est réaffichée à chaque visite).
async function matchingStats(req, res) {
  const days = req.query.days || 30;
  const since = [days];

  const [funnel] = await query(
    `SELECT ${pairOf('impression')} AS shown, ${pairOf('click')} AS clicked,
            COUNT(DISTINCT CASE WHEN event_type = 'propose' AND score IS NOT NULL THEN CONCAT(user_id, '-', candidate_id) END) AS proposed,
            COUNT(DISTINCT CASE WHEN event_type = 'propose' AND score IS NULL THEN CONCAT(user_id, '-', candidate_id) END) AS proposedWithoutReco,
            COUNT(DISTINCT user_id) AS usersServed,
            ROUND(AVG(CASE WHEN event_type = 'impression' THEN score END), 1) AS avgScore
     FROM recommendation_events
     WHERE created_at >= (NOW() - INTERVAL ? DAY)`,
    since
  );

  // Le score prédit-il le comportement ? (un bon modèle : plus le score est haut, plus on clique / propose)
  const buckets = await query(
    `SELECT CASE WHEN score >= 70 THEN 'high' WHEN score >= 40 THEN 'medium' ELSE 'low' END AS bucket,
            ${pairOf('impression')} AS shown, ${pairOf('click')} AS clicked, ${pairOf('propose')} AS proposed
     FROM recommendation_events
     WHERE score IS NOT NULL AND created_at >= (NOW() - INTERVAL ? DAY)
     GROUP BY bucket`,
    since
  );

  const [members] = await query(
    `SELECT (SELECT COUNT(*) FROM users WHERE role = 'user' AND is_active = 1) AS total,
            (SELECT COUNT(DISTINCT us.user_id) FROM user_skills us JOIN users u ON u.id = us.user_id
              WHERE u.role = 'user' AND u.is_active = 1) AS withSkills`
  );

  const shown = Number(funnel?.shown || 0);
  const clicked = Number(funnel?.clicked || 0);
  const proposed = Number(funnel?.proposed || 0);
  const order = ['high', 'medium', 'low'];
  const byBucket = new Map(buckets.map((b) => [b.bucket, b]));

  res.json({
    days,
    ml: await mlHealth(),
    funnel: {
      shown,
      clicked,
      proposed,
      proposedWithoutReco: Number(funnel?.proposedWithoutReco || 0),
      usersServed: Number(funnel?.usersServed || 0),
      avgScore: funnel?.avgScore == null ? null : Number(funnel.avgScore),
      clickRate: rate(clicked, shown),
      proposeRate: rate(proposed, shown)
    },
    buckets: order.map((name) => {
      const b = byBucket.get(name) || {};
      const sh = Number(b.shown || 0);
      const cl = Number(b.clicked || 0);
      const pr = Number(b.proposed || 0);
      return { bucket: name, shown: sh, clicked: cl, proposed: pr, clickRate: rate(cl, sh), proposeRate: rate(pr, sh) };
    }),
    members: { total: Number(members?.total || 0), withSkills: Number(members?.withSkills || 0) }
  });
}

module.exports = {
  idParam,
  listUsersRules,
  listExchangesRules,
  matchingStatsRules,
  duplicatesRules,
  mergeSkillsRules,
  updateUserRules,
  createAdminRules,
  categoryRules,
  skillRules,
  dashboard,
  listUsers,
  updateUser,
  createCategory,
  createSkill,
  deleteSkill,
  listExchanges,
  matchingStats,
  catalogDuplicates,
  mergeSkills,
  createAdmin,
  listAuditLogs
};
