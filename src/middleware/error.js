const config = require('../config/env');

function httpError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

function notFound(_req, res) {
  res.status(404).json({ message: 'Ressource introuvable.' });
}

// Traduit les erreurs techniques (MySQL, body-parser) en réponses HTTP propres.
function normalize(err) {
  if (err.status && err.expose !== false && !err.type) return err;
  if (err.type === 'entity.parse.failed') return httpError(400, 'JSON invalide.');
  if (err.type === 'entity.too.large') return httpError(413, 'Requête trop volumineuse.');
  switch (err.code) {
    case 'ER_DUP_ENTRY':
      return httpError(409, 'Cet élément existe déjà.');
    case 'ER_NO_REFERENCED_ROW_2':
      return httpError(422, 'Référence invalide (élément inexistant).');
    case 'ER_ROW_IS_REFERENCED_2':
      return httpError(409, 'Suppression impossible : élément encore utilisé.');
    default:
      return err;
  }
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  const error = normalize(err);
  const status = error.status || 500;
  if (status >= 500) {
    console.error(`[${req.id || '-'}]`, err);
  }
  res.status(status).json({
    message: status >= 500 && config.isProd ? 'Erreur interne du serveur.' : error.message || 'Erreur interne du serveur.',
    details: status < 500 ? error.details : undefined,
    requestId: req.id
  });
}

module.exports = { notFound, errorHandler, httpError };
