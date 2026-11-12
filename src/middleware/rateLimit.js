const rateLimit = require('express-rate-limit');
const config = require('../config/env');

const make = (windowMs, max, message) =>
  rateLimit({
    windowMs,
    max: config.isTest ? 10000 : max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message }
  });

module.exports = {
  global: make(15 * 60 * 1000, 400, 'Trop de requêtes, réessayez plus tard.'),
  // Anti brute-force sur la connexion / inscription
  auth: make(15 * 60 * 1000, 20, 'Trop de tentatives, réessayez dans 15 minutes.'),
  // Appels au modèle de langage : coûteux (quota) → plafonnés par minute et par IP
  ai: make(60 * 1000, 15, "Trop de demandes à l'IA, patientez un instant."),
  // Réinitialisation de mot de passe : très restrictif
  reset: make(60 * 60 * 1000, 8, 'Trop de demandes de réinitialisation, réessayez dans une heure.')
};
