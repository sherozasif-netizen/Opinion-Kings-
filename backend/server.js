const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { getDb } = require('./database');
const waitlistRoutes = require('./routes/waitlist');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Security & parsing ─────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// ─── Rate limiting ──────────────────────────────────────────────────
const joinLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a minute.' },
  keyGenerator: (req) => req.ip,
});

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down.' },
});

app.use('/api/waitlist/join', joinLimiter);
app.use('/api/waitlist/me', readLimiter);
app.use('/api/waitlist/leaderboard', readLimiter);

// ─── Serve static frontend (parent directory) ───────────────────────
app.use(express.static(path.join(__dirname, '..')));

// ─── API routes ─────────────────────────────────────────────────────
app.use('/api/waitlist', waitlistRoutes);

// ─── Health check ───────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) AS cnt FROM waitlist_users').get();
  res.json({ status: 'ok', waitlist_count: count.cnt });
});

// ─── Error handler ──────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: 'Internal server error.' });
});

// ─── Start ──────────────────────────────────────────────────────────
app.listen(PORT, () => {
  getDb();
  console.log(`\n  Opinion Kings Waitlist API`);
  console.log(`  ─────────────────────────`);
  console.log(`  Running on http://localhost:${PORT}`);
  console.log(`  API base:  http://localhost:${PORT}/api/waitlist`);
  console.log(`  Frontend:  http://localhost:${PORT}/index.html\n`);
});
