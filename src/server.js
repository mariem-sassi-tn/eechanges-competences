const config = require('./config/env');
const app = require('./app');
const { pool } = require('./config/db');

async function start() {
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    console.error('Impossible de joindre MySQL. Vérifiez que le serveur est démarré et le .env correct.');
    console.error(error.message);
    process.exit(1);
  }

  const server = app.listen(config.port, () => {
    console.log(`API Echanges Competences sur http://localhost:${config.port} (${config.isProd ? 'production' : 'dev'})`);
  });

  // Arrêt propre : on finit les requêtes en cours puis on ferme le pool MySQL.
  const shutdown = (signal) => {
    console.log(`${signal} reçu, arrêt en cours…`);
    server.close(async () => {
      await pool.end().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => console.error('unhandledRejection:', reason));

start();
