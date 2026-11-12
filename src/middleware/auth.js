const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { query } = require('../config/db');
const { httpError } = require('./error');

// Vérifie le JWT puis recharge l'utilisateur en base : un compte désactivé
// ou dont le rôle a changé est pris en compte immédiatement (pas après 8 h).
async function authenticate(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return next(httpError(401, 'Authentification requise.'));
  }

  let payload;
  try {
    payload = jwt.verify(token, config.jwt.secret);
  } catch {
    return next(httpError(401, 'Session expirée ou jeton invalide.'));
  }

  try {
    const rows = await query(
      'SELECT id, email, role, is_active FROM users WHERE id = ? LIMIT 1',
      [payload.id]
    );
    if (!rows.length || !rows[0].is_active) {
      return next(httpError(401, 'Compte introuvable ou désactivé.'));
    }
    req.user = { id: rows[0].id, email: rows[0].email, role: rows[0].role };
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(httpError(403, 'Accès réservé à un autre espace.'));
    }
    next();
  };
}

module.exports = { authenticate, requireRole };
