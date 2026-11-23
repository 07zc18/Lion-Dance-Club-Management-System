
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, 'club-data.sqlite'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Database tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS club_data (
    user_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS user_security (
    user_id INTEGER PRIMARY KEY,
    pin_hash TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS payment_unlock_tokens (
    jti TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

// Add committee_role to existing accounts without resetting them.
const userColumns = db.prepare('PRAGMA table_info(users)').all();
if (!userColumns.some(column => column.name === 'committee_role')) {
  db.exec(`
    ALTER TABLE users
    ADD COLUMN committee_role TEXT NOT NULL DEFAULT 'Member'
  `);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const secret =
  process.env.JWT_SECRET || 'change-this-secret-before-deployment';

const sign = user =>
  jwt.sign(
    {
      id: user.id,
      email: user.email,
      name: user.name
    },
    secret,
    { expiresIn: '7d' }
  );

function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || '')
      .replace(/^Bearer\s+/, '');

    if (!token) throw new Error('Missing token');

    req.user = jwt.verify(token, secret);
    next();
  } catch {
    res.status(401).json({ error: 'Please log in again.' });
  }
}

function getUser(id) {
  return db.prepare(`
    SELECT id, name, email, committee_role AS committeeRole
    FROM users
    WHERE id=?
  `).get(id);
}

// Account registration
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};

    if (
      !name?.trim() ||
      !email?.trim() ||
      !password ||
      password.length < 8
    ) {
      return res.status(400).json({
        error: 'Enter your name, a valid email and a password with at least 8 characters.'
      });
    }

    const hash = await bcrypt.hash(password, 12);

    const info = db.prepare(`
      INSERT INTO users(name, email, password_hash, committee_role)
      VALUES(?,?,?,'Member')
    `).run(
      name.trim(),
      email.trim().toLowerCase(),
      hash
    );

    const user = getUser(info.lastInsertRowid);

    db.prepare(`
      INSERT INTO club_data(user_id, data) VALUES(?,?)
    `).run(
      user.id,
      JSON.stringify({
        clubName: 'Lion Dance Club',
        roles: [
          { id: 'head', name: 'Lion Head', rate: 150 },
          { id: 'tail', name: 'Lion Tail', rate: 150 },
          { id: 'drum', name: 'Drummer', rate: 120 },
          { id: 'cymbals', name: 'Cymbals', rate: 100 },
          { id: 'gong', name: 'Gong', rate: 100 },
          { id: 'other', name: 'Other', rate: 80 }
        ],
        orders: [],
        performers: [],
        utilities: [],
        purchases: []
      })
    );

    res.json({ token: sign(user), user });
  } catch (e) {
    if (String(e).includes('UNIQUE')) {
      return res.status(409).json({
        error: 'An account with this email already exists.'
      });
    }

    console.error('Registration error:', e);
    res.status(500).json({ error: 'Could not create account.' });
  }
});

// Account login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};

    const row = db.prepare(`
      SELECT * FROM users WHERE email=?
    `).get(String(email || '').trim().toLowerCase());

    if (!row || !(await bcrypt.compare(password || '', row.password_hash))) {
      return res.status(401).json({
        error: 'Email or password is incorrect.'
      });
    }

    const user = getUser(row.id);

    res.json({ token: sign(user), user });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Could not log in.' });
  }
});

// Current account
app.get('/api/auth/me', auth, (req, res) => {
  const user = getUser(req.user.id);

  if (!user) {
    return res.status(401).json({ error: 'Account no longer exists.' });
  }

  res.json({ user });
});

// Update committee role
app.put('/api/auth/account', auth, (req, res) => {
  const committeeRole = String(
    req.body?.committeeRole || ''
  ).trim();

  if (!committeeRole || committeeRole.length > 60) {
    return res.status(400).json({
      error: 'Enter a committee role with no more than 60 characters.'
    });
  }

  const result = db.prepare(`
    UPDATE users
    SET committee_role=?
    WHERE id=?
  `).run(committeeRole, req.user.id);

  if (!result.changes) {
    return res.status(404).json({ error: 'Account not found.' });
  }

  res.json({
    ok: true,
    user: getUser(req.user.id)
  });
});

// Delete the signed-in account.
// Password confirmation is required to prevent accidental deletion.
app.delete('/api/auth/account', auth, async (req, res) => {
  try {
    const password = req.body?.password;

    if (!password) {
      return res.status(400).json({
        error: 'Enter your account password to confirm deletion.'
      });
    }

    const row = db.prepare(`
      SELECT password_hash FROM users WHERE id=?
    `).get(req.user.id);

    if (!row) {
      return res.status(404).json({ error: 'Account not found.' });
    }

    const matches = await bcrypt.compare(password, row.password_hash);

    if (!matches) {
      return res.status(403).json({
        error: 'The account password is incorrect.'
      });
    }

    const deleteAccount = db.transaction(() => {
      db.prepare('DELETE FROM payment_unlock_tokens WHERE user_id=?')
        .run(req.user.id);

      db.prepare('DELETE FROM user_security WHERE user_id=?')
        .run(req.user.id);

      db.prepare('DELETE FROM club_data WHERE user_id=?')
        .run(req.user.id);

      db.prepare('DELETE FROM users WHERE id=?')
        .run(req.user.id);
    });

    deleteAccount();

    res.json({ ok: true, message: 'Account deleted successfully.' });
  } catch (e) {
    console.error('Account deletion error:', e);
    res.status(500).json({ error: 'Could not delete account.' });
  }
});

// Read account data
app.get('/api/data', auth, (req, res) => {
  const row = db.prepare(`
    SELECT data FROM club_data WHERE user_id=?
  `).get(req.user.id);

  res.json(row ? JSON.parse(row.data) : {});
});

// Save account data.
// Paid records can now be edited without a PIN.
app.put('/api/data', auth, (req, res) => {
  const data = req.body;

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return res.status(400).json({ error: 'Invalid data.' });
  }

  try {
    db.prepare(`
      INSERT INTO club_data(user_id, data, updated_at)
      VALUES(?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(user_id)
      DO UPDATE SET
        data=excluded.data,
        updated_at=CURRENT_TIMESTAMP
    `).run(req.user.id, JSON.stringify(data));

    res.json({ ok: true });
  } catch (e) {
    console.error('Save account data error:', e);
    res.status(500).json({ error: 'Could not save account data.' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Serve frontend
const dist = path.join(__dirname, '../dist');
app.use(express.static(dist));

app.get('*', (req, res) => {
  res.sendFile(path.join(dist, 'index.html'));
});

const port = process.env.PORT || 5000;

app.listen(port, '0.0.0.0', () => {
  console.log(`Lion Dance Club server running on ${port}`);
});
