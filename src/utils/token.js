const jwt = require('jsonwebtoken');
const config = require('../config/env');

function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn
  });
}

function parseCv(raw) {
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

function publicUser(user) {
  return {
    id: user.id,
    firstName: user.first_name,
    lastName: user.last_name,
    email: user.email,
    role: user.role,
    bio: user.bio,
    city: user.city,
    avatarUrl: user.avatar_url,
    cvData: parseCv(user.cv_data),
    isActive: Boolean(user.is_active),
    createdAt: user.created_at
  };
}

module.exports = { signToken, publicUser, parseCv };
