const { query } = require('../config/db');

// Journal d'audit des actions d'administration. Ne doit jamais faire échouer la requête.
async function audit(adminId, action, targetType, targetId, details) {
  try {
    await query(
      'INSERT INTO audit_logs (admin_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)',
      [adminId, action, targetType, targetId ?? null, details ? JSON.stringify(details) : null]
    );
  } catch (error) {
    console.error('Audit non enregistré :', error.message);
  }
}

module.exports = { audit };
