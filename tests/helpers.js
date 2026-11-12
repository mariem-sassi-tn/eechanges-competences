// Utilitaires de test : base de données simulée (aucun MySQL requis) + serveur HTTP éphémère.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.DB_NAME = 'test';

const path = require('path');
const jwt = require('jsonwebtoken');

let handler = async () => [];
const calls = [];

// Remplace config/db avant le chargement de l'app.
const dbPath = require.resolve(path.join(__dirname, '../src/config/db'));
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    pool: { query: async () => [[{ 1: 1 }]], end: async () => {} },
    query: async (sql, params) => {
      calls.push({ sql, params });
      return handler(sql.replace(/\s+/g, ' ').trim(), params);
    }
  }
};

const app = require('../src/app');

function setDb(fn) {
  handler = fn;
  calls.length = 0;
}

function tokenFor(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function startServer() {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(method, url, { body, token, raw } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(body !== undefined || raw ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined)
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* corps vide */
    }
    return { status: res.status, body: json };
  }
  return { request, close: () => new Promise((r) => server.close(r)) };
}

module.exports = { setDb, tokenFor, startServer, calls };
