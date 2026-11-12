const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { body } = require('express-validator');
const { query } = require('../config/db');
const { httpError } = require('../middleware/error');
const { signToken, publicUser } = require('../utils/token');
const { sendMail } = require('../utils/mailer');

const MAX_RESET_ATTEMPTS = 5;
const RESET_TTL_MS = 15 * 60 * 1000;

const strongPassword = body('password')
  .isLength({ min: 8, max: 72 })
  .withMessage('Mot de passe : 8 à 72 caractères.')
  .matches(/[A-Za-z]/)
  .withMessage('Le mot de passe doit contenir au moins une lettre.')
  .matches(/\d/)
  .withMessage('Le mot de passe doit contenir au moins un chiffre.');

const registerRules = [
  body('firstName').trim().isLength({ min: 2, max: 80 }).withMessage('Prénom : 2 à 80 caractères.'),
  body('lastName').trim().isLength({ min: 2, max: 80 }).withMessage('Nom : 2 à 80 caractères.'),
  body('email').isEmail().withMessage('Email invalide.').normalizeEmail(),
  strongPassword,
  body('city').optional({ values: 'falsy' }).trim().isLength({ max: 120 }).withMessage('Ville trop longue.'),
  body('bio').optional({ values: 'falsy' }).trim().isLength({ max: 2000 }).withMessage('Bio trop longue.')
];

const loginRules = [
  body('email').isEmail().withMessage('Email invalide.').normalizeEmail(),
  body('password').isString().notEmpty().withMessage('Mot de passe requis.')
];

const forgotRules = [body('email').isEmail().withMessage('Email invalide.').normalizeEmail()];

const resetRules = [
  body('email').isEmail().withMessage('Email invalide.').normalizeEmail(),
  body('code').isString().matches(/^\d{6}$/).withMessage('Le code contient 6 chiffres.'),
  body('newPassword')
    .isLength({ min: 8, max: 72 })
    .withMessage('Mot de passe : 8 à 72 caractères.')
    .matches(/[A-Za-z]/)
    .withMessage('Le mot de passe doit contenir au moins une lettre.')
    .matches(/\d/)
    .withMessage('Le mot de passe doit contenir au moins un chiffre.')
];

// Hash valide pour égaliser le temps de réponse quand l'e-mail n'existe pas.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

const hashCode = (code) => crypto.createHash('sha256').update(code).digest('hex');

async function register(req, res) {
  const { firstName, lastName, email, password, city, bio } = req.body;
  const existing = await query('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
  if (existing.length) {
    throw httpError(409, 'Cet e-mail est déjà utilisé.');
  }
  const hash = await bcrypt.hash(password, 10);
  const result = await query(
    `INSERT INTO users (first_name, last_name, email, password_hash, city, bio, role)
     VALUES (?, ?, ?, ?, ?, ?, 'user')`,
    [firstName, lastName, email, hash, city || null, bio || null]
  );
  const rows = await query('SELECT * FROM users WHERE id = ?', [result.insertId]);
  res.status(201).json({ token: signToken(rows[0]), user: publicUser(rows[0]) });
}

async function login(req, res) {
  const { email, password } = req.body;
  const rows = await query('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
  const user = rows[0];
  // Même coût de calcul que l'utilisateur existe ou non (limite l'énumération par timing).
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) {
    throw httpError(401, 'Identifiants incorrects.');
  }
  if (!user.is_active) {
    throw httpError(403, 'Compte désactivé. Contactez un administrateur.');
  }
  res.json({ token: signToken(user), user: publicUser(user) });
}

async function me(req, res) {
  const rows = await query('SELECT * FROM users WHERE id = ? LIMIT 1', [req.user.id]);
  if (!rows.length) {
    throw httpError(404, 'Utilisateur introuvable.');
  }
  res.json({ user: publicUser(rows[0]) });
}

// Réponse identique que l'e-mail existe ou non (pas d'énumération de comptes).
async function forgotPassword(req, res) {
  const { email } = req.body;
  const rows = await query('SELECT id FROM users WHERE email = ? AND is_active = 1 LIMIT 1', [email]);
  if (rows.length) {
    const code = String(crypto.randomInt(100000, 1000000));
    await query(
      'UPDATE users SET reset_code = ?, reset_code_expires = ?, reset_attempts = 0 WHERE id = ?',
      [hashCode(code), new Date(Date.now() + RESET_TTL_MS), rows[0].id]
    );
    await sendMail({
      to: email,
      subject: 'Votre code de réinitialisation',
      text: `Votre code : ${code}\nIl expire dans 15 minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.`
    });
  }
  res.json({ message: 'Si un compte existe avec cet e-mail, un code vient d’être envoyé.' });
}

async function resetPassword(req, res) {
  const { email, code, newPassword } = req.body;
  const rows = await query(
    'SELECT id, reset_code, reset_code_expires, reset_attempts FROM users WHERE email = ? LIMIT 1',
    [email]
  );
  const user = rows[0];
  const invalid = httpError(400, 'Code invalide ou expiré.');

  if (!user || !user.reset_code || !user.reset_code_expires || new Date(user.reset_code_expires) < new Date()) {
    throw invalid;
  }
  if (user.reset_attempts >= MAX_RESET_ATTEMPTS) {
    throw httpError(429, 'Trop d’essais. Demandez un nouveau code.');
  }

  const expected = Buffer.from(user.reset_code);
  const given = Buffer.from(hashCode(code));
  const match = expected.length === given.length && crypto.timingSafeEqual(expected, given);
  if (!match) {
    await query('UPDATE users SET reset_attempts = reset_attempts + 1 WHERE id = ?', [user.id]);
    throw invalid;
  }

  const hash = await bcrypt.hash(newPassword, 10);
  await query(
    'UPDATE users SET password_hash = ?, reset_code = NULL, reset_code_expires = NULL, reset_attempts = 0 WHERE id = ?',
    [hash, user.id]
  );
  res.json({ message: 'Mot de passe réinitialisé avec succès.' });
}

module.exports = {
  registerRules,
  loginRules,
  forgotRules,
  resetRules,
  register,
  login,
  me,
  forgotPassword,
  resetPassword
};
