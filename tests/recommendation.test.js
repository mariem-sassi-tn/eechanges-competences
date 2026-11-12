// Le service ML est remplacé par un faux : ces tests ne nécessitent ni MySQL ni Python.
process.env.ML_SERVICE_URL = 'http://ml.test:8000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setDb, tokenFor, startServer, calls } = require('./helpers');
const service = require('../src/services/recommendation');

const sara = { id: 3, email: 'sara@x.tn', role: 'user' };
const admin = { id: 1, email: 'admin@x.tn', role: 'admin' };
const original = { ...service };

let api;
test.before(async () => {
  api = await startServer();
});
test.after(() => api.close());
test.afterEach(() => Object.assign(service, original));

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

const baseRoutes = (skillRows) => [
  ['SELECT id, city FROM users WHERE role', [{ id: 2, city: 'Sfax' }, { id: 4, city: 'Sousse' }]],
  ['SELECT city FROM users WHERE id = ?', [{ city: 'Tunis' }]],
  ['FROM user_skills us JOIN skills s', skillRows]
];

const skills = [
  { user_id: 3, skill_id: 1, type: 'offer', skillName: 'Anglais' },
  { user_id: 3, skill_id: 5, type: 'need', skillName: 'Figma' },
  { user_id: 2, skill_id: 5, type: 'offer', skillName: 'Figma' },
  { user_id: 4, skill_id: 10, type: 'offer', skillName: 'Piano' }
];

test('GET /api/recommendations sans jeton → 401', async () => {
  const r = await api.request('GET', '/api/recommendations');
  assert.equal(r.status, 401);
});

test('un admin n’a pas de recommandations → 403', async () => {
  db([]);
  const r = await api.request('GET', '/api/recommendations', { token: tokenFor(admin) });
  assert.equal(r.status, 403);
});

test('retourne les scores au-dessus du seuil, et journalise les impressions', async () => {
  let sent;
  service.fetchScores = async (user, candidates) => {
    sent = { user, candidates };
    return {
      model: 'fake-model',
      results: [
        { id: 2, score: 92, reasons: [{ kind: 'they_offer', skill: 'Figma', matches: 'Figma', exact: true }] },
        { id: 4, score: 5, reasons: [] } // sous le seuil (15) : non renvoyé
      ]
    };
  };
  db(baseRoutes(skills));

  const r = await api.request('GET', '/api/recommendations', { token: tokenFor(sara) });
  assert.equal(r.status, 200);
  assert.equal(r.body.available, true);
  assert.equal(r.body.model, 'fake-model');
  assert.deepEqual(r.body.recommendations.map((x) => [x.userId, x.score]), [[2, 92]]);

  // Le ML reçoit le profil du membre connecté et les candidats avec leurs compétences.
  assert.equal(sent.user.id, 3);
  assert.deepEqual(sent.user.needs, [{ skillId: 5, name: 'Figma' }]);
  assert.equal(sent.candidates.length, 2);

  const insert = calls.find((c) => c.sql.includes('INSERT INTO recommendation_events'));
  assert.ok(insert, 'impression non enregistrée');
  assert.deepEqual(insert.params[0], [[3, 2, 'impression', 92, 'fake-model']]);
});

test('ml-service en panne → 200 avec available:false (pas d’erreur côté interface)', async () => {
  service.fetchScores = async () => null;
  db(baseRoutes(skills));
  const r = await api.request('GET', '/api/recommendations', { token: tokenFor(sara) });
  assert.equal(r.status, 200);
  assert.equal(r.body.available, false);
  assert.deepEqual(r.body.recommendations, []);
});

test('membre sans compétences : pas d’appel au ML, raison no_skills', async () => {
  let called = false;
  service.fetchScores = async () => {
    called = true;
    return { results: [] };
  };
  db(baseRoutes([{ user_id: 2, skill_id: 5, type: 'offer', skillName: 'Figma' }]));
  const r = await api.request('GET', '/api/recommendations', { token: tokenFor(sara) });
  assert.equal(r.status, 200);
  assert.equal(r.body.reason, 'no_skills');
  assert.equal(called, false);
});

test('POST /events : clic valide → 204, enregistré', async () => {
  db([['SELECT id FROM users WHERE id = ?', [{ id: 2 }]]]);
  const r = await api.request('POST', '/api/recommendations/events', { token: tokenFor(sara), body: { candidateId: 2, type: 'click' } });
  assert.equal(r.status, 204);
  const insert = calls.find((c) => c.sql.includes('INSERT INTO recommendation_events'));
  assert.deepEqual(insert.params.slice(0, 3), [3, 2, 'click']);
});

test('POST /events : type invalide → 422, membre inconnu → 404, soi-même → 422', async () => {
  db([['SELECT id FROM users WHERE id = ?', []]]);
  const bad = await api.request('POST', '/api/recommendations/events', { token: tokenFor(sara), body: { candidateId: 2, type: 'propose' } });
  assert.equal(bad.status, 422);
  const unknown = await api.request('POST', '/api/recommendations/events', { token: tokenFor(sara), body: { candidateId: 99, type: 'click' } });
  assert.equal(unknown.status, 404);
  const self = await api.request('POST', '/api/recommendations/events', { token: tokenFor(sara), body: { candidateId: 3, type: 'click' } });
  assert.equal(self.status, 422);
});

test('GET /api/users?q= élargit la recherche aux compétences proches (IA)', async () => {
  service.searchSkills = async () => [{ skillId: 7, name: 'Illustration', score: 0.8 }];
  db([
    ['SELECT id, name FROM skills', [{ id: 7, name: 'Illustration' }]],
    ['SELECT COUNT(*) AS total', [{ total: 0 }]]
  ]);
  const r = await api.request('GET', '/api/users?q=dessiner', { token: tokenFor(sara) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.meta.semantic, ['Illustration']);
  const count = calls.find((c) => c.sql.includes('COUNT(*)'));
  assert.deepEqual(count.params[5], [7]);
});

test('recherche : si le ml-service est indisponible, retour à la recherche classique', async () => {
  service.searchSkills = async () => null;
  db([
    ['SELECT id, name FROM skills', [{ id: 7, name: 'Illustration' }]],
    ['SELECT COUNT(*) AS total', [{ total: 0 }]]
  ]);
  const r = await api.request('GET', '/api/users?q=dessiner', { token: tokenFor(sara) });
  assert.equal(r.status, 200);
  assert.equal(r.body.meta.semantic, undefined);
  const count = calls.find((c) => c.sql.includes('COUNT(*)'));
  assert.equal(count.params.length, 7);
});

test('GET /api/users/me/skill-suggestions : analyse bio + CV, exclut les compétences déjà possédées', async () => {
  let sent;
  service.suggestSkills = async (texts, catalog, excludeIds) => {
    sent = { texts, catalog, excludeIds };
    return [{ skillId: 5, name: 'Figma', score: 0.9, evidence: 'Je crée des maquettes' }];
  };
  db([
    ['SELECT bio, cv_data FROM users', [{ bio: 'Designer. Je crée des maquettes', cv_data: JSON.stringify({ headline: 'UI', experiences: [{ role: 'Designer', description: 'Figma' }] }) }]],
    ['FROM skills s JOIN categories c', [{ id: 5, name: 'Figma', categoryName: 'Design' }]],
    ['SELECT DISTINCT skill_id FROM user_skills', [{ skill_id: 1 }]]
  ]);
  const r = await api.request('GET', '/api/users/me/skill-suggestions', { token: tokenFor(sara) });
  assert.equal(r.status, 200);
  assert.equal(r.body.available, true);
  assert.deepEqual(r.body.suggestions[0], { skillId: 5, name: 'Figma', categoryName: 'Design', score: 0.9, evidence: 'Je crée des maquettes' });
  assert.deepEqual(sent.excludeIds, [1]);
  assert.ok(sent.texts.includes('Je crée des maquettes') && sent.texts.includes('UI'));
});

test('suggestions : profil vide → no_text ; ml-service indisponible → available:false (jamais 5xx)', async () => {
  db([['SELECT bio, cv_data FROM users', [{ bio: null, cv_data: null }]]]);
  let r = await api.request('GET', '/api/users/me/skill-suggestions', { token: tokenFor(sara) });
  assert.equal(r.status, 200);
  assert.equal(r.body.reason, 'no_text');

  service.suggestSkills = async () => null;
  db([
    ['SELECT bio, cv_data FROM users', [{ bio: 'Je suis designer', cv_data: null }]],
    ['FROM skills s JOIN categories c', [{ id: 5, name: 'Figma', categoryName: 'Design' }]],
    ['SELECT DISTINCT skill_id FROM user_skills', []]
  ]);
  r = await api.request('GET', '/api/users/me/skill-suggestions', { token: tokenFor(sara) });
  assert.equal(r.status, 200);
  assert.equal(r.body.available, false);
  assert.deepEqual(r.body.suggestions, []);
});

// ---- Matching enrichi : détail du troc, membre, proposition prête à envoyer ----------------------

test('GET /api/recommendations : détail du troc, membre et proposition pré-remplie', async () => {
  let sent;
  service.fetchScores = async (user, candidates) => {
    sent = { user, candidates };
    return {
      model: 'fake-model',
      results: [
        {
          id: 2,
          score: 92,
          forward: 1,
          backward: 0.8,
          reasons: [
            { kind: 'they_offer', skill: 'Figma', matches: 'Figma', exact: true },
            { kind: 'they_need', skill: 'Anglais', matches: 'Anglais', exact: true }
          ]
        }
      ]
    };
  };
  db([
    ['SELECT id, city FROM users WHERE role', [{ id: 2, city: 'Sfax' }]],
    ['SELECT city FROM users WHERE id = ?', [{ city: 'Tunis' }]],
    [
      'FROM user_skills us JOIN skills s',
      [
        { us_id: 11, user_id: 3, skill_id: 1, type: 'offer', level: 'expert', skillName: 'Anglais' },
        { us_id: 12, user_id: 3, skill_id: 5, type: 'need', level: 'beginner', skillName: 'Figma' },
        { us_id: 21, user_id: 2, skill_id: 5, type: 'offer', level: 'inconnu', skillName: 'Figma' },
        { us_id: 22, user_id: 2, skill_id: 1, type: 'need', level: 'beginner', skillName: 'Anglais' }
      ]
    ],
    ['FROM reviews', [{ reviewee_id: 2, rating: '4.5' }]],
    ['FROM users u WHERE u.id IN', [{ id: 2, first_name: 'Yassine', last_name: 'B', city: 'Sfax', avatar_url: null }]]
  ]);

  const r = await api.request('GET', '/api/recommendations', { token: tokenFor(sara) });
  assert.equal(r.status, 200);
  const [reco] = r.body.recommendations;
  assert.equal(reco.forward, 100);
  assert.equal(reco.backward, 80);
  assert.equal(reco.mutual, true);
  assert.deepEqual(reco.member, { firstName: 'Yassine', lastName: 'B', city: 'Sfax', avatarUrl: null });
  // J'offre mon « Anglais » (user_skills 11) contre son « Figma » (user_skills 21).
  assert.equal(reco.proposal.offeredUserSkillId, 11);
  assert.equal(reco.proposal.requestedUserSkillId, 21);

  // Le niveau (valide) et la note du candidat sont transmis au ML ; un niveau inconnu est ignoré.
  assert.equal(sent.user.offers[0].level, 'expert');
  assert.equal(sent.candidates[0].rating, 4.5);
  assert.equal(sent.candidates[0].offers[0].level, undefined);
});

test('GET /api/admin/matching-stats : entonnoir, tranches de score et santé du ML', async () => {
  db([
    ['FROM recommendation_events WHERE created_at', [{ shown: 40, clicked: 10, proposed: 4, proposedWithoutReco: 1, usersServed: 6, avgScore: '61.5' }]],
    ['GROUP BY bucket', [{ bucket: 'high', shown: 10, clicked: 6, proposed: 3 }]],
    ['SELECT (SELECT COUNT(*) FROM users', [{ total: 20, withSkills: 15 }]]
  ]);
  const r = await api.request('GET', '/api/admin/matching-stats?days=7', { token: tokenFor(admin) });
  assert.equal(r.status, 200);
  assert.equal(r.body.days, 7);
  assert.equal(r.body.funnel.clickRate, 25);
  assert.equal(r.body.funnel.proposeRate, 10);
  assert.equal(r.body.funnel.avgScore, 61.5);
  assert.deepEqual(r.body.buckets.map((b) => b.bucket), ['high', 'medium', 'low']);
  assert.equal(r.body.buckets[0].clickRate, 60);
  assert.equal(r.body.buckets[1].shown, 0);
  assert.equal(r.body.members.withSkills, 15);
  assert.equal(typeof r.body.ml.up, 'boolean');
});

test('GET /api/admin/matching-stats : réservé à l’admin, days borné', async () => {
  db([]);
  const asUser = await api.request('GET', '/api/admin/matching-stats', { token: tokenFor(sara) });
  assert.equal(asUser.status, 403);
  const bad = await api.request('GET', '/api/admin/matching-stats?days=9999', { token: tokenFor(admin) });
  assert.equal(bad.status, 422);
});
