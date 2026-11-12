const { body } = require('express-validator');
const { query } = require('../config/db');
const config = require('../config/env');
const { httpError } = require('../middleware/error');
// Appels via l'objet module (et non déstructurés) pour pouvoir les remplacer dans les tests.
const recommendation = require('../services/recommendation');

const MAX_CANDIDATES = 500;
const MAX_RETURNED = 50;

const eventRules = [
  body('candidateId').isInt({ min: 1 }).withMessage('Membre invalide.').toInt(),
  body('type').isIn(['click']).withMessage('Type d’événement invalide.')
];

const LEVELS = new Set(['beginner', 'intermediate', 'expert']);
// Une couverture ≥ 50 % dans les DEUX sens = vrai troc réciproque.
const MUTUAL_MIN = 0.5;

async function loadSkills(userIds) {
  const rows = await query(
    `SELECT us.id AS us_id, us.user_id, us.skill_id, us.type, us.level, s.name AS skillName
     FROM user_skills us
     JOIN skills s ON s.id = us.skill_id
     WHERE us.user_id IN (?)`,
    [userIds]
  );
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, { offers: [], needs: [], ids: new Map() });
    const entry = byUser.get(r.user_id);
    const skill = { skillId: r.skill_id, name: r.skillName };
    if (LEVELS.has(r.level)) skill.level = r.level; // un niveau inconnu est simplement ignoré
    entry[r.type === 'offer' ? 'offers' : 'needs'].push(skill);
    // id de la ligne user_skills : sert à pré-remplir la proposition d'échange.
    entry.ids.set(`${r.type}:${r.skillName}`, r.us_id ?? null);
  }
  return byUser;
}

// Note moyenne des avis reçus (la réputation pèse un peu dans le score).
async function loadRatings(userIds) {
  const rows = await query(
    'SELECT reviewee_id, ROUND(AVG(rating), 1) AS rating FROM reviews WHERE reviewee_id IN (?) GROUP BY reviewee_id',
    [userIds]
  );
  return new Map(rows.map((r) => [r.reviewee_id, Number(r.rating)]));
}

async function loadMembers(userIds) {
  if (!userIds.length) return new Map();
  const rows = await query(
    'SELECT u.id, u.first_name, u.last_name, u.city, u.avatar_url FROM users u WHERE u.id IN (?)',
    [userIds]
  );
  return new Map(
    rows.map((u) => [
      u.id,
      { firstName: u.first_name, lastName: u.last_name, city: u.city ?? null, avatarUrl: u.avatar_url ?? null }
    ])
  );
}

const toPercent = (v) => (typeof v === 'number' ? Math.round(v * 100) : null);

// Transforme les « raisons » du ML en proposition d'échange prête à envoyer :
//   they_offer → ce que JE demande (leur offre) ; they_need → ce que J'offre (mon offre qui répond à leur besoin).
function buildProposal(myIds, theirIds, reasons) {
  const proposal = { offeredUserSkillId: null, requestedUserSkillId: null, offeredSkill: null, requestedSkill: null };
  for (const r of reasons) {
    if (r.kind === 'they_offer' && proposal.requestedUserSkillId === null) {
      const id = theirIds?.get(`offer:${r.skill}`) ?? null;
      if (id) Object.assign(proposal, { requestedUserSkillId: id, requestedSkill: r.skill });
    } else if (r.kind === 'they_need' && proposal.offeredUserSkillId === null) {
      const id = myIds?.get(`offer:${r.matches}`) ?? null;
      if (id) Object.assign(proposal, { offeredUserSkillId: id, offeredSkill: r.matches });
    }
  }
  return proposal;
}

// GET /api/recommendations → scores de compatibilité du membre connecté avec les autres membres.
async function list(req, res) {
  const me = req.user.id;
  const others = await query(
    "SELECT id, city FROM users WHERE role = 'user' AND is_active = 1 AND id != ? ORDER BY id LIMIT ?",
    [me, MAX_CANDIDATES]
  );
  const unavailable = { available: false, model: null, recommendations: [] };
  if (!config.ml.url || !others.length) return res.json(unavailable);

  const skills = await loadSkills([me, ...others.map((u) => u.id)]);
  const mine = skills.get(me);
  // Sans compétences, aucun score n'a de sens (le front invite à compléter le profil).
  if (!mine || (!mine.offers.length && !mine.needs.length)) {
    return res.json({ ...unavailable, available: true, reason: 'no_skills' });
  }
  const meCity = (await query('SELECT city FROM users WHERE id = ?', [me]))[0]?.city ?? null;
  const ratings = await loadRatings(others.map((u) => u.id));
  const candidates = others
    .filter((u) => skills.has(u.id))
    .map((u) => {
      const { offers, needs } = skills.get(u.id);
      return { id: u.id, city: u.city, ...(ratings.has(u.id) ? { rating: ratings.get(u.id) } : {}), offers, needs };
    });

  const result = await recommendation.fetchScores({ id: me, city: meCity, offers: mine.offers, needs: mine.needs }, candidates);
  if (!result || !Array.isArray(result.results)) return res.json(unavailable);

  const kept = result.results.filter((r) => r.score >= config.ml.minScore).slice(0, MAX_RETURNED);
  const members = await loadMembers(kept.map((r) => r.id));

  const recommendations = kept.map((r) => {
    const reasons = r.reasons || [];
    return {
      userId: r.id,
      score: r.score,
      reasons,
      forward: toPercent(r.forward), // ce que l'autre m'apporte
      backward: toPercent(r.backward), // ce que je lui apporte
      mutual: r.forward >= MUTUAL_MIN && r.backward >= MUTUAL_MIN,
      member: members.get(r.id) ?? null,
      proposal: buildProposal(mine.ids, skills.get(r.id)?.ids, reasons)
    };
  });

  await recommendation.logImpressions(me, recommendations, result.model);
  res.json({ available: true, model: result.model, recommendations });
}

// POST /api/recommendations/events → le membre a ouvert un profil recommandé.
async function track(req, res) {
  const { candidateId, type } = req.body;
  if (candidateId === req.user.id) throw httpError(422, 'Membre invalide.');
  const exists = await query("SELECT id FROM users WHERE id = ? AND role = 'user' AND is_active = 1", [candidateId]);
  if (!exists.length) throw httpError(404, 'Membre introuvable.');
  await recommendation.recordEvent(req.user.id, candidateId, type);
  res.status(204).end();
}

module.exports = { eventRules, list, track };
