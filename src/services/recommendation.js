const config = require('../config/env');
const { query } = require('../config/db');

// Appelle le ml-service. Ne lève jamais : en cas de panne / timeout on retourne null
// et l'interface s'affiche simplement sans badge (la recommandation est un bonus).
async function fetchScores(user, candidates) {
  if (!config.ml.url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ml.timeoutMs);
  try {
    const res = await fetch(`${config.ml.url}/v1/recommend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, candidates }),
      signal: controller.signal
    });
    if (!res.ok) {
      console.error(`ml-service a répondu ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (error) {
    console.error('ml-service injoignable :', error.name === 'AbortError' ? 'timeout' : error.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Recherche sémantique : compétences du catalogue proches du texte tapé. Ne lève jamais (null = pas d'IA).
async function searchSkills(text, skills) {
  if (!config.ml.url || !skills.length) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ml.timeoutMs);
  try {
    const res = await fetch(`${config.ml.url}/v1/search-skills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: text, skills: skills.map((s) => ({ skillId: s.id, name: s.name })), topK: 5 }),
      signal: controller.signal
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.results) ? data.results : null;
  } catch (error) {
    console.error('Recherche sémantique indisponible :', error.name === 'AbortError' ? 'timeout' : error.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Suggestion de compétences à partir d'extraits du profil (bio, CV). Ne lève jamais (null = pas d'IA).
async function suggestSkills(texts, skills, excludeIds) {
  if (!config.ml.url || !texts.length || !skills.length) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ml.timeoutMs);
  try {
    const res = await fetch(`${config.ml.url}/v1/suggest-skills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts, skills: skills.map((s) => ({ skillId: s.id, name: s.name })), excludeIds, topK: 8 }),
      signal: controller.signal
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.results) ? data.results : null;
  } catch (error) {
    console.error('Suggestion de compétences indisponible :', error.name === 'AbortError' ? 'timeout' : error.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Doublons probables dans le catalogue (« Anglais » / « English »). Ne lève jamais (null = pas d'IA).
async function findDuplicates(skills, minCosine) {
  if (!config.ml.url || skills.length < 2) return config.ml.url ? [] : null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(config.ml.timeoutMs, 15000));
  try {
    const res = await fetch(`${config.ml.url}/v1/find-duplicates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skills: skills.map((s) => ({ skillId: s.id, name: s.name })), minCosine }),
      signal: controller.signal
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.clusters) ? data.clusters : null;
  } catch (error) {
    console.error('Détection de doublons indisponible :', error.name === 'AbortError' ? 'timeout' : error.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Journal : ne doit jamais faire échouer la requête principale.
async function logImpressions(userId, items, model) {
  if (!items.length) return;
  try {
    const rows = items.map((r) => [userId, r.userId, 'impression', r.score, model || null]);
    await query(
      'INSERT INTO recommendation_events (user_id, candidate_id, event_type, score, model_version) VALUES ?',
      [rows]
    );
  } catch (error) {
    console.error('Impressions non enregistrées :', error.message);
  }
}

// Reprend le score de la dernière impression de cette paire (NULL si le membre n'avait pas été recommandé).
async function recordEvent(userId, candidateId, type) {
  try {
    await query(
      `INSERT INTO recommendation_events (user_id, candidate_id, event_type, score, model_version)
       SELECT ?, ?, ?, ri.score, ri.model_version
       FROM (SELECT 1) d
       LEFT JOIN (
         SELECT score, model_version FROM recommendation_events
         WHERE user_id = ? AND candidate_id = ? AND event_type = 'impression'
         ORDER BY id DESC LIMIT 1
       ) ri ON 1 = 1`,
      [userId, candidateId, type, userId, candidateId]
    );
  } catch (error) {
    console.error('Événement de recommandation non enregistré :', error.message);
  }
}

module.exports = { fetchScores, searchSkills, suggestSkills, findDuplicates, logImpressions, recordEvent };
