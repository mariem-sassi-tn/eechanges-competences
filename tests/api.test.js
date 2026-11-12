const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { setDb, tokenFor, startServer, calls } = require('./helpers');

const sara = { id: 3, email: 'sara@x.tn', role: 'user' };
const yassine = { id: 2, email: 'yassine@x.tn', role: 'user' };
const admin = { id: 1, email: 'admin@x.tn', role: 'admin' };

let api;
test.before(async () => {
  api = await startServer();
});
test.after(() => api.close());

// Base simulée : routes SQL → réponses
function db(routes) {
  setDb(async (sql, params) => {
    for (const [pattern, fn] of routes) {
      if (sql.includes(pattern)) return typeof fn === 'function' ? fn(params, sql) : fn;
    }
    return [];
  });
}
const activeUser = (u) => ['SELECT id, email, role, is_active FROM users WHERE id = ?', (p) => [{ ...[sara, yassine, admin].find((x) => x.id === p[0]), is_active: 1 }]];

test('GET /api/health répond ok', async () => {
  const r = await api.request('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('route inconnue → 404 JSON', async () => {
  const r = await api.request('GET', '/api/nope');
  assert.equal(r.status, 404);
});

test('JSON invalide → 400 (et non 500)', async () => {
  const r = await api.request('POST', '/api/auth/login', { raw: '{bad json' });
  assert.equal(r.status, 400);
});

test('sans jeton → 401', async () => {
  const r = await api.request('GET', '/api/users');
  assert.equal(r.status, 401);
});

test('compte désactivé : le jeton existant est refusé immédiatement', async () => {
  db([['SELECT id, email, role, is_active FROM users WHERE id = ?', [{ ...sara, is_active: 0 }]]]);
  const r = await api.request('GET', '/api/exchanges', { token: tokenFor(sara) });
  assert.equal(r.status, 401);
});

test('le rôle est relu en base : un ex-admin rétrogradé perd l’accès admin', async () => {
  db([['SELECT id, email, role, is_active FROM users WHERE id = ?', [{ ...admin, role: 'user', is_active: 1 }]]]);
  const r = await api.request('GET', '/api/admin/dashboard', { token: tokenFor(admin) });
  assert.equal(r.status, 403);
});

test('login : mauvais mot de passe → 401', async () => {
  const hash = await bcrypt.hash('Correct123', 4);
  db([['SELECT * FROM users WHERE email = ?', [{ id: 3, email: 'sara@x.tn', password_hash: hash, role: 'user', is_active: 1 }]]]);
  const r = await api.request('POST', '/api/auth/login', { body: { email: 'sara@x.tn', password: 'Wrong123' } });
  assert.equal(r.status, 401);
});

test('login : succès → jeton + utilisateur public (sans hash)', async () => {
  const hash = await bcrypt.hash('Correct123', 4);
  db([['SELECT * FROM users WHERE email = ?', [{ id: 3, first_name: 'Sara', last_name: 'M', email: 'sara@x.tn', password_hash: hash, role: 'user', is_active: 1 }]]]);
  const r = await api.request('POST', '/api/auth/login', { body: { email: 'sara@x.tn', password: 'Correct123' } });
  assert.equal(r.status, 200);
  assert.ok(r.body.token);
  assert.equal(r.body.user.password_hash, undefined);
});

test('login : e-mail inconnu → même message 401 (pas d’énumération)', async () => {
  db([]);
  const r = await api.request('POST', '/api/auth/login', { body: { email: 'ghost@x.tn', password: 'Whatever1' } });
  assert.equal(r.status, 401);
  assert.equal(r.body.message, 'Identifiants incorrects.');
});

test('login : compte désactivé → 403', async () => {
  const hash = await bcrypt.hash('Correct123', 4);
  db([['SELECT * FROM users WHERE email = ?', [{ id: 3, email: 'sara@x.tn', password_hash: hash, role: 'user', is_active: 0 }]]]);
  const r = await api.request('POST', '/api/auth/login', { body: { email: 'sara@x.tn', password: 'Correct123' } });
  assert.equal(r.status, 403);
});

test('register : mot de passe sans chiffre → 422', async () => {
  const r = await api.request('POST', '/api/auth/register', {
    body: { firstName: 'Ali', lastName: 'Ben', email: 'ali@x.tn', password: 'abcdefghij' }
  });
  assert.equal(r.status, 422);
});

test('register : e-mail déjà pris → 409', async () => {
  db([['SELECT id FROM users WHERE email = ?', [{ id: 1 }]]]);
  const r = await api.request('POST', '/api/auth/register', {
    body: { firstName: 'Ali', lastName: 'Ben', email: 'ali@x.tn', password: 'Password123' }
  });
  assert.equal(r.status, 409);
});

test('forgot-password : réponse identique pour un e-mail inconnu (200)', async () => {
  db([]);
  const r = await api.request('POST', '/api/auth/forgot-password', { body: { email: 'ghost@x.tn' } });
  assert.equal(r.status, 200);
  assert.match(r.body.message, /Si un compte existe/);
});

test('forgot-password : le code est stocké haché (jamais en clair)', async () => {
  db([['SELECT id FROM users WHERE email = ? AND is_active = 1', [{ id: 3 }]]]);
  const r = await api.request('POST', '/api/auth/forgot-password', { body: { email: 'sara@x.tn' } });
  assert.equal(r.status, 200);
  const update = calls.find((c) => c.sql.includes('UPDATE users SET reset_code'));
  assert.ok(update);
  assert.match(update.params[0], /^[0-9a-f]{64}$/);
});

test('reset-password : mauvais code → 400 + compteur d’essais incrémenté', async () => {
  db([
    ['SELECT id, reset_code', [{ id: 3, reset_code: 'a'.repeat(64), reset_code_expires: new Date(Date.now() + 60000), reset_attempts: 0 }]]
  ]);
  const r = await api.request('POST', '/api/auth/reset-password', {
    body: { email: 'sara@x.tn', code: '123456', newPassword: 'NewPass123' }
  });
  assert.equal(r.status, 400);
  assert.ok(calls.some((c) => c.sql.includes('reset_attempts = reset_attempts + 1')));
});

test('reset-password : trop d’essais → 429', async () => {
  db([
    ['SELECT id, reset_code', [{ id: 3, reset_code: 'a'.repeat(64), reset_code_expires: new Date(Date.now() + 60000), reset_attempts: 5 }]]
  ]);
  const r = await api.request('POST', '/api/auth/reset-password', {
    body: { email: 'sara@x.tn', code: '123456', newPassword: 'NewPass123' }
  });
  assert.equal(r.status, 429);
});

test('un utilisateur simple ne peut pas appeler /api/admin → 403', async () => {
  db([activeUser()]);
  const r = await api.request('GET', '/api/admin/users', { token: tokenFor(sara) });
  assert.equal(r.status, 403);
});

test('échange avec soi-même → 422', async () => {
  db([activeUser()]);
  const r = await api.request('POST', '/api/exchanges', { token: tokenFor(sara), body: { partnerId: 3 } });
  assert.equal(r.status, 422);
});

test('échange : compétence demandée qui n’appartient pas au partenaire → 422', async () => {
  db([
    activeUser(),
    ['SELECT id FROM users WHERE id = ? AND is_active = 1', [{ id: 2 }]],
    ['FROM user_skills WHERE id = ?', []]
  ]);
  const r = await api.request('POST', '/api/exchanges', {
    token: tokenFor(sara),
    body: { partnerId: 2, offeredUserSkillId: 4, requestedUserSkillId: 999 }
  });
  assert.equal(r.status, 422);
});

test('échange : création valide → 201', async () => {
  db([
    activeUser(),
    ['SELECT id FROM users WHERE id = ? AND is_active = 1', [{ id: 2 }]],
    ['FROM user_skills WHERE id = ?', [{ id: 1 }]],
    ['SELECT id FROM exchanges', []],
    ['INSERT INTO exchanges', { insertId: 42 }]
  ]);
  const r = await api.request('POST', '/api/exchanges', {
    token: tokenFor(sara),
    body: { partnerId: 2, offeredUserSkillId: 4, requestedUserSkillId: 1, message: 'Salut' }
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.id, 42);
});

test('statut : le demandeur ne peut pas accepter sa propre demande → 403', async () => {
  db([
    activeUser(),
    ['SELECT * FROM exchanges WHERE id = ?', [{ id: 7, requester_id: 3, partner_id: 2, status: 'pending' }]]
  ]);
  const r = await api.request('PATCH', '/api/exchanges/7/status', { token: tokenFor(sara), body: { status: 'accepted' } });
  assert.equal(r.status, 403);
});

test('statut : un échange terminé ne peut plus être annulé → 409', async () => {
  db([
    activeUser(),
    ['SELECT * FROM exchanges WHERE id = ?', [{ id: 7, requester_id: 3, partner_id: 2, status: 'completed' }]]
  ]);
  const r = await api.request('PATCH', '/api/exchanges/7/status', { token: tokenFor(sara), body: { status: 'cancelled' } });
  assert.equal(r.status, 409);
});

test('statut : acceptation par le destinataire → 200 avec UPDATE conditionnel', async () => {
  db([
    activeUser(),
    ['SELECT * FROM exchanges WHERE id = ?', [{ id: 7, requester_id: 3, partner_id: 2, status: 'pending' }]],
    ['UPDATE exchanges SET status = ? WHERE id = ? AND status = ?', { affectedRows: 1 }]
  ]);
  const r = await api.request('PATCH', '/api/exchanges/7/status', { token: tokenFor(yassine), body: { status: 'accepted' } });
  assert.equal(r.status, 200);
  const upd = calls.find((c) => c.sql.startsWith('UPDATE exchanges'));
  assert.deepEqual(upd.params, ['accepted', 7, 'pending']);
});

test('statut : course critique (déjà modifié) → 409', async () => {
  db([
    activeUser(),
    ['SELECT * FROM exchanges WHERE id = ?', [{ id: 7, requester_id: 3, partner_id: 2, status: 'pending' }]],
    ['UPDATE exchanges SET status = ? WHERE id = ? AND status = ?', { affectedRows: 0 }]
  ]);
  const r = await api.request('PATCH', '/api/exchanges/7/status', { token: tokenFor(yassine), body: { status: 'accepted' } });
  assert.equal(r.status, 409);
});

test('message refusé tant que l’échange n’est pas accepté → 403', async () => {
  db([
    activeUser(),
    ['SELECT * FROM exchanges WHERE id = ?', [{ id: 7, requester_id: 3, partner_id: 2, status: 'pending' }]]
  ]);
  const r = await api.request('POST', '/api/exchanges/7/messages', { token: tokenFor(sara), body: { content: 'Coucou' } });
  assert.equal(r.status, 403);
});

test('avis : note hors limites → 422', async () => {
  db([activeUser()]);
  const r = await api.request('POST', '/api/exchanges/7/reviews', { token: tokenFor(sara), body: { rating: 9 } });
  assert.equal(r.status, 422);
});

test('admin ne peut pas se désactiver lui-même → 422', async () => {
  db([activeUser()]);
  const r = await api.request('PATCH', '/api/admin/users/1', { token: tokenFor(admin), body: { isActive: false } });
  assert.equal(r.status, 422);
});

test('admin : changement de rôle journalisé dans audit_logs', async () => {
  db([
    activeUser(),
    ['UPDATE users SET role', { affectedRows: 1 }],
    ['SELECT * FROM users WHERE id = ?', [{ id: 3, first_name: 'S', last_name: 'M', email: 's@x.tn', role: 'admin', is_active: 1 }]]
  ]);
  const r = await api.request('PATCH', '/api/admin/users/3', { token: tokenFor(admin), body: { role: 'admin' } });
  assert.equal(r.status, 200);
  assert.ok(calls.some((c) => c.sql.includes('INSERT INTO audit_logs')));
});

test('admin : rôle invalide → 422', async () => {
  db([activeUser()]);
  const r = await api.request('PATCH', '/api/admin/users/3', { token: tokenFor(admin), body: { role: 'superuser' } });
  assert.equal(r.status, 422);
});

test('profil : photo qui n’est pas une image → 422', async () => {
  db([activeUser()]);
  const r = await api.request('PATCH', '/api/users/me', { token: tokenFor(sara), body: { avatarUrl: 'javascript:alert(1)' } });
  assert.equal(r.status, 422);
});

test('profil : mise à jour partielle ne touche que les champs envoyés', async () => {
  db([
    activeUser(),
    ['UPDATE users SET', { affectedRows: 1 }],
    ['SELECT * FROM users WHERE id = ?', [{ id: 3, first_name: 'Sara', last_name: 'M', email: 's@x.tn', role: 'user', city: 'Sfax', is_active: 1 }]]
  ]);
  const r = await api.request('PATCH', '/api/users/me', { token: tokenFor(sara), body: { city: 'Sfax' } });
  assert.equal(r.status, 200);
  const upd = calls.find((c) => c.sql.startsWith('UPDATE users SET'));
  assert.equal(upd.sql, 'UPDATE users SET city = ? WHERE id = ?');
});

test('annuaire : les jokers LIKE sont échappés', async () => {
  db([
    activeUser(),
    ['SELECT COUNT(*) AS total', [{ total: 0 }]]
  ]);
  const r = await api.request('GET', '/api/users?q=100%25_', { token: tokenFor(sara) });
  assert.equal(r.status, 200);
  const count = calls.find((c) => c.sql.includes('COUNT(*)'));
  assert.equal(count.params[1], '%100\\%\\_%');
});
