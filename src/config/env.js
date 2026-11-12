require('dotenv').config();

const isProd = process.env.NODE_ENV === 'production';
// Refuse les valeurs d'exemple / de développement en production.
const WEAK_SECRET = /(change|changez|dev-only|dev-secret|example|password|^secret$)/i;

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variable d'environnement manquante : ${name}`);
  }
  return value;
}

const jwtSecret = required('JWT_SECRET');
if (isProd && (jwtSecret.length < 32 || WEAK_SECRET.test(jwtSecret))) {
  throw new Error('JWT_SECRET trop faible pour la production (32 caractères aléatoires minimum).');
}

module.exports = {
  isProd,
  isTest: process.env.NODE_ENV === 'test',
  port: Number(process.env.PORT || 3000),
  clientOrigins: (process.env.CLIENT_ORIGIN || 'http://localhost:4200').split(',').map((s) => s.trim()),
  trustProxy: process.env.TRUST_PROXY === '1',
  jwt: { secret: jwtSecret, expiresIn: process.env.JWT_EXPIRES_IN || '8h' },
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    name: process.env.DB_NAME || 'echanges_competences'
  },
  // Service de recommandation (Python). Vide = fonctionnalité désactivée, l'application marche sans.
  ml: {
    url: (process.env.ML_SERVICE_URL || '').replace(/\/+$/, ''),
    timeoutMs: Number(process.env.ML_TIMEOUT_MS || 5000),
    minScore: Number(process.env.ML_MIN_SCORE || 15)
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'TalentXchange <no-reply@echanges.local>'
  }
};
