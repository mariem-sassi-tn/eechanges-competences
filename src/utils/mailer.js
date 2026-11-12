const nodemailer = require('nodemailer');
const config = require('../config/env');

let transporter = null;
function getTransporter() {
  if (!config.smtp.host) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined
    });
  }
  return transporter;
}

// Envoie un e-mail via SMTP. Sans SMTP configuré (dev), le contenu est affiché en console.
async function sendMail({ to, subject, text }) {
  const t = getTransporter();
  if (!t) {
    if (!config.isProd && !config.isTest) {
      console.log(`\n[mail:dev] À: ${to}\n[mail:dev] Sujet: ${subject}\n[mail:dev] ${text}\n`);
    } else if (config.isProd) {
      console.warn('SMTP non configuré : e-mail non envoyé.');
    }
    return;
  }
  await t.sendMail({ from: config.smtp.from, to, subject, text });
}

module.exports = { sendMail };
