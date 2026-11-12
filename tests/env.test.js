const test = require('node:test');
const assert = require('node:assert/strict');

function loadEnv(vars) {
  const saved = { ...process.env };
  Object.assign(process.env, vars);
  const key = require.resolve('../src/config/env');
  delete require.cache[key];
  try {
    return require('../src/config/env');
  } finally {
    process.env = saved;
    delete require.cache[key];
  }
}

test('JWT_SECRET faible refusé en production', () => {
  assert.throws(() => loadEnv({ NODE_ENV: 'production', JWT_SECRET: 'changez-cette-cle-en-production' }), /trop faible/);
  assert.throws(() => loadEnv({ NODE_ENV: 'production', JWT_SECRET: 'court' }), /trop faible/);
});

test('JWT_SECRET fort accepté en production', () => {
  const cfg = loadEnv({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(48) });
  assert.equal(cfg.isProd, true);
});

test('CLIENT_ORIGIN accepte plusieurs origines', () => {
  const cfg = loadEnv({ NODE_ENV: 'test', JWT_SECRET: 'abc', CLIENT_ORIGIN: 'http://a.com, http://b.com' });
  assert.deepEqual(cfg.clientOrigins, ['http://a.com', 'http://b.com']);
});

test('les secrets d’exemple (.env.example, docker-compose) sont refusés en production', () => {
  for (const weak of ['dev-only-secret-change-me-please-0123456789', 'changez-moi-avec-une-longue-valeur-aleatoire', 'echanges-competences-dev-secret-2026']) {
    assert.throws(() => loadEnv({ NODE_ENV: 'production', JWT_SECRET: weak }), /trop faible/, weak);
  }
});
