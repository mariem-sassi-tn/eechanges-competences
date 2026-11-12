const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const config = require('./config/env');
const limits = require('./middleware/rateLimit');
const requestId = require('./middleware/requestId');
const { notFound, errorHandler } = require('./middleware/error');
const { pool } = require('./config/db');

const app = express();

if (config.trustProxy) app.set('trust proxy', 1); // derrière nginx / reverse proxy
app.disable('x-powered-by');

app.use(requestId);
app.use(helmet());
app.use(
  cors({
    origin(origin, cb) {
      // Autorise les outils sans en-tête Origin (curl, tests) et les origines déclarées.
      if (!origin || config.clientOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true
  })
);

if (!config.isTest) {
  morgan.token('id', (req) => req.id);
  app.use(morgan(config.isProd ? ':id :remote-addr :method :url :status :res[content-length] - :response-time ms' : 'dev'));
}

// Photo de profil en base64 : limite large uniquement sur cette route, 100 ko ailleurs.
app.use('/api/users/me', express.json({ limit: '4mb' }));
app.use(express.json({ limit: '100kb' }));
app.use(limits.global);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'echanges-competences-api', uptime: Math.round(process.uptime()) });
});

// Readiness : vérifie aussi la base (utile pour Docker / orchestrateur).
app.get('/api/health/ready', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'up' });
  } catch {
    res.status(503).json({ ok: false, db: 'down' });
  }
});

app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/users', require('./routes/user.routes'));
app.use('/api/catalog', require('./routes/skill.routes'));
app.use('/api/recommendations', require('./routes/recommendation.routes'));
app.use('/api/exchanges', require('./routes/exchange.routes'));
app.use('/api/admin', require('./routes/admin.routes'));
app.use('/api/support', require('./routes/support.routes'));

app.use(notFound);
app.use(errorHandler);

module.exports = app;
