// Fonctions IA : message d'ouverture, brouillon de réponse support, doublons du catalogue.
// Le modèle de langage (fetch) et le ml-service sont remplacés par des faux : ni réseau, ni MySQL, ni Python.
process.env.ML_SERVICE_URL = 'http://ml.test:8000';
// Aucune vraie clé IA pendant les tests (une chaîne vide empêche dotenv de charger celle du .env).
process.env.GEMINI_API_KEY = '';
process.env.OPENAI_API_KEY = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setDb, tokenFor, startServer } = require('./helpers');
const service = require('../src/services/recommendation');
const dbModule = require('../src/config/db');

const sara = { id: 3, email: 'sara@x.tn', role: 'user' };
const admin = { id: 1, email: 'admin@x.tn', role: 'admin' };
const original = { ...service };
const realFetch = global.fetch;

let api;
test.before(async () => {
  api = await startServer();
});
test.after(() => api.close());
test.afterEach(() => {
  Object.assign(service, original);
  global.fetch = realFetch;
  process.env.GEMINI_API_KEY = '';
});

function db(routes) {
  setDb(async (sql, params) => {
    if (sql.startsWith('SELECT id, email, role, is_active FROM users WHERE id = ?')) {
      return [{ ...[sara, admin].find((u) => u.id === params[0]), is_active: 1 }];
    }
    for (const [pattern, value] of routes) {
      if (sql.includes(pattern)) return typeof value === 'function' ? value(params, sql) : value;
    }
    return [];
  });
}

const fakeModel = (text) => {
  global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) });
};

const draftRoutes = [
  ['SELECT first_name FROM users WHERE id = ? AND is_active = 1', [{ first_name: 'Yassine' }]],
  ['FROM user_skills WHERE id = ?', [{ id: 1 }]],
  ['FROM user_skills us JOIN skills s', [{ id: 11, name: 'Anglais' }, { id: 21, name: 'Figma' }]],
  ['SELECT first_name, bio FROM users WHERE id = ?', [{ first_name: 'Sara', bio: 'Designer' }]]
];
const draftBody = { partnerId: 2, offeredUserSkillId: 11, requestedUserSkillId: 21 };

test('message d’ouverture : sans clé IA → modèle de texte avec les bonnes compétences', async () => {
  db(draftRoutes);
  const r = await api.request('POST', '/api/exchanges/draft-message', { token: tokenFor(sara), body: draftBody });
  assert.equal(r.status, 200);
  assert.equal(r.body.ai, false);
  assert.match(r.body.message, /Yassine/);
  assert.match(r.body.message, /Figma/);
  assert.match(r.body.message, /Anglais/);
});

test('message d’ouverture : avec IA → texte du modèle', async () => {
  process.env.GEMINI_API_KEY = 'AIzaFAKE';
  fakeModel('Bonjour Yassine, je cherche Figma.');
  db(draftRoutes);
  const r = await api.request('POST', '/api/exchanges/draft-message', { token: tokenFor(sara), body: draftBody });
  assert.equal(r.body.ai, true);
  assert.equal(r.body.message, 'Bonjour Yassine, je cherche Figma.');
});

test('message d’ouverture : quota IA dépassé → repli sur le modèle de texte (pas d’erreur)', async () => {
  process.env.GEMINI_API_KEY = 'AIzaFAKE';
  global.fetch = async () => ({ ok: false, status: 429, text: async () => '{}' });
  db(draftRoutes);
  const r = await api.request('POST', '/api/exchanges/draft-message', { token: tokenFor(sara), body: draftBody });
  assert.equal(r.status, 200);
  assert.equal(r.body.ai, false);
});

test('message d’ouverture : soi-même → 422, partenaire inconnu → 404', async () => {
  db(draftRoutes);
  const self = await api.request('POST', '/api/exchanges/draft-message', { token: tokenFor(sara), body: { partnerId: 3 } });
  assert.equal(self.status, 422);
  db([['SELECT first_name FROM users WHERE id = ? AND is_active = 1', []]]);
  const unknown = await api.request('POST', '/api/exchanges/draft-message', { token: tokenFor(sara), body: { partnerId: 99 } });
  assert.equal(unknown.status, 404);
});

test('brouillon de réponse support : résumé + brouillon, JSON entouré de ```json accepté', async () => {
  process.env.GEMINI_API_KEY = 'AIzaFAKE';
  fakeModel('```json\n{"summary":"Connexion impossible","draft":"Bonjour, quelle erreur voyez-vous ?"}\n```');
  db([
    ["SELECT id FROM users WHERE id = ? AND role = 'user'", [{ id: 2 }]],
    ['FROM support_messages m', [{ id: 1, senderRole: 'user', content: 'Je ne peux pas me connecter' }]]
  ]);
  const r = await api.request('POST', '/api/support/threads/2/draft-reply', { token: tokenFor(admin) });
  assert.equal(r.status, 200);
  assert.equal(r.body.summary, 'Connexion impossible');
  assert.match(r.body.draft, /quelle erreur/);
});

test('brouillon de réponse support : réservé à l’admin, 503 si l’IA n’est pas configurée', async () => {
  db([]);
  const asUser = await api.request('POST', '/api/support/threads/2/draft-reply', { token: tokenFor(sara) });
  assert.equal(asUser.status, 403);
  db([
    ["SELECT id FROM users WHERE id = ? AND role = 'user'", [{ id: 2 }]],
    ['FROM support_messages m', [{ id: 1, senderRole: 'user', content: 'Aide' }]]
  ]);
  const noKey = await api.request('POST', '/api/support/threads/2/draft-reply', { token: tokenFor(admin) });
  assert.equal(noKey.status, 503);
});

test('doublons du catalogue : groupes enrichis avec le nombre d’usages', async () => {
  service.findDuplicates = async () => [{ score: 0.93, skills: [{ skillId: 2, name: 'English' }, { skillId: 1, name: 'Anglais' }] }];
  db([['GROUP BY s.id', [{ id: 1, name: 'Anglais', uses: 5 }, { id: 2, name: 'English', uses: 2 }]]]);
  const r = await api.request('GET', '/api/admin/catalog-duplicates?threshold=0.8', { token: tokenFor(admin) });
  assert.equal(r.status, 200);
  assert.equal(r.body.available, true);
  assert.deepEqual(r.body.clusters[0].skills.map((s) => [s.id, s.uses]), [[1, 5], [2, 2]]);

  service.findDuplicates = async () => null;
  const off = await api.request('GET', '/api/admin/catalog-duplicates', { token: tokenFor(admin) });
  assert.equal(off.body.available, false);
});

test('fusion de compétences : transaction, échanges repointés, audit', async () => {
  const log = [];
  dbModule.pool.getConnection = async () => ({
    beginTransaction: async () => log.push('BEGIN'),
    query: async (sql, params) => log.push([sql.replace(/\s+/g, ' ').trim(), params]),
    commit: async () => log.push('COMMIT'),
    rollback: async () => log.push('ROLLBACK'),
    release: () => log.push('RELEASE')
  });
  db([['SELECT id FROM skills WHERE id IN', [{ id: 1 }, { id: 2 }]]]);
  const r = await api.request('POST', '/api/admin/skills/merge', { token: tokenFor(admin), body: { keepId: 1, mergeIds: [2] } });
  assert.equal(r.status, 200);
  assert.equal(r.body.merged, 1);
  assert.equal(log[0], 'BEGIN');
  assert.ok(log.some((l) => Array.isArray(l) && l[0].startsWith('UPDATE exchanges') && l[0].includes('offered_user_skill_id')));
  assert.ok(log.some((l) => Array.isArray(l) && l[0].startsWith('UPDATE IGNORE user_skills')));
  assert.ok(log.some((l) => Array.isArray(l) && l[0].startsWith('DELETE FROM skills')));
  assert.equal(log.at(-2), 'COMMIT');
});

test('fusion de compétences : validations', async () => {
  db([['SELECT id FROM skills WHERE id IN', [{ id: 1 }]]]);
  const none = await api.request('POST', '/api/admin/skills/merge', { token: tokenFor(admin), body: { keepId: 1, mergeIds: [1] } });
  assert.equal(none.status, 422);
  const unknown = await api.request('POST', '/api/admin/skills/merge', { token: tokenFor(admin), body: { keepId: 1, mergeIds: [99] } });
  assert.equal(unknown.status, 404);
  const asUser = await api.request('POST', '/api/admin/skills/merge', { token: tokenFor(sara), body: { keepId: 1, mergeIds: [2] } });
  assert.equal(asUser.status, 403);
});
