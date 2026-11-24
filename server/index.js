import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createClient } from '@libsql/client';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required.');
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
  intMode: 'number'
});

// Initialize tables without deleting existing records.
async function initializeDatabase() {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      committee_role TEXT NOT NULL DEFAULT 'Member'
    )`,

    `CREATE TABLE IF NOT EXISTS club_data (
      user_id INTEGER PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      version INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`,

    `CREATE TABLE IF NOT EXISTS user_security (
      user_id INTEGER PRIMARY KEY,
      pin_hash TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`,

    `CREATE TABLE IF NOT EXISTS payment_unlock_tokens (
      jti TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`
  ], 'write');

  // Preserve compatibility with older database schemas.
  const clubColumns = await db.execute('PRAGMA table_info(club_data)');

  if (!clubColumns.rows.some(column => column.name === 'version')) {
    await db.execute(`
      ALTER TABLE club_data
      ADD COLUMN version INTEGER NOT NULL DEFAULT 1
    `);
  }

  const userColumns = await db.execute('PRAGMA table_info(users)');

  if (!userColumns.rows.some(column => column.name === 'committee_role')) {
    await db.execute(`
      ALTER TABLE users
      ADD COLUMN committee_role TEXT NOT NULL DEFAULT 'Member'
    `);
  }

  console.log('Turso database initialized successfully.');
}

const app = express();

app.use(cors());
app.use(express.json({ limit: '5mb' }));

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production.');
}

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

async function getUser(id) {
  const result = await db.execute({
    sql: `
      SELECT id, name, email, committee_role AS committeeRole
      FROM users
      WHERE id = ?
    `,
    args: [id]
  });

  return result.rows[0] || null;
}

// Account registration
app.post('/api/auth/register', async (req, res) => {
  let tx;

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

    tx = await db.transaction('write');

    const info = await tx.execute({
      sql: `
        INSERT INTO users(name, email, password_hash, committee_role)
        VALUES(?,?,?,'Member')
      `,
      args: [
        name.trim(),
        email.trim().toLowerCase(),
        hash
      ]
    });

    const userId = Number(info.lastInsertRowid);

    await tx.execute({
      sql: `
        INSERT INTO club_data(user_id, data)
        VALUES(?,?)
      `,
      args: [
        userId,
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
      ]
    });

    const user = await getUser(userId);

    await tx.commit();
    tx = null;

    res.json({ token: sign(user), user });

  } catch (e) {
    if (tx) {
      try { await tx.rollback(); } catch {}
    }

    if (/UNIQUE constraint failed/i.test(String(e.message || e))) {
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

    const result = await db.execute({
      sql: 'SELECT * FROM users WHERE email = ?',
      args: [String(email || '').trim().toLowerCase()]
    });

    const row = result.rows[0];

    if (!row || !(await bcrypt.compare(password || '', row.password_hash))) {
      return res.status(401).json({
        error: 'Email or password is incorrect.'
      });
    }

    const user = await getUser(row.id);

    if (!user) {
      return res.status(401).json({
        error: 'Account no longer exists.'
      });
    }

    res.json({ token: sign(user), user });

  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Could not log in.' });
  }
});

// Current account
app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const user = await getUser(req.user.id);

    if (!user) {
      return res.status(401).json({
        error: 'Account no longer exists.'
      });
    }

    res.json({ user });

  } catch (e) {
    console.error('Account verification error:', e);
    res.status(500).json({ error: 'Could not verify account.' });
  }
});

// Update committee role
app.put('/api/auth/account', auth, async (req, res) => {
  try {
    const committeeRole = String(
      req.body?.committeeRole || ''
    ).trim();

    if (!committeeRole || committeeRole.length > 60) {
      return res.status(400).json({
        error: 'Enter a committee role with no more than 60 characters.'
      });
    }

    const result = await db.execute({
      sql: `
        UPDATE users
        SET committee_role = ?
        WHERE id = ?
      `,
      args: [committeeRole, req.user.id]
    });

    if (!result.rowsAffected) {
      return res.status(404).json({ error: 'Account not found.' });
    }

    const user = await getUser(req.user.id);

    res.json({ ok: true, user });

  } catch (e) {
    console.error('Committee role update error:', e);
    res.status(500).json({ error: 'Could not update committee role.' });
  }
});

// Delete the signed-in account.
app.delete('/api/auth/account', auth, async (req, res) => {
  let tx;

  try {
    const password = req.body?.password;

    if (!password) {
      return res.status(400).json({
        error: 'Enter your account password to confirm deletion.'
      });
    }

    const result = await db.execute({
      sql: 'SELECT password_hash FROM users WHERE id = ?',
      args: [req.user.id]
    });

    const row = result.rows[0];

    if (!row) {
      return res.status(404).json({ error: 'Account not found.' });
    }

    const matches = await bcrypt.compare(password, row.password_hash);

    if (!matches) {
      return res.status(403).json({
        error: 'The account password is incorrect.'
      });
    }

    tx = await db.transaction('write');

    await tx.execute({
      sql: 'DELETE FROM payment_unlock_tokens WHERE user_id = ?',
      args: [req.user.id]
    });

    await tx.execute({
      sql: 'DELETE FROM user_security WHERE user_id = ?',
      args: [req.user.id]
    });

    await tx.execute({
      sql: 'DELETE FROM club_data WHERE user_id = ?',
      args: [req.user.id]
    });

    await tx.execute({
      sql: 'DELETE FROM users WHERE id = ?',
      args: [req.user.id]
    });

    await tx.commit();
    tx = null;

    res.json({
      ok: true,
      message: 'Account deleted successfully.'
    });

  } catch (e) {
    if (tx) {
      try { await tx.rollback(); } catch {}
    }

    console.error('Account deletion error:', e);
    res.status(500).json({ error: 'Could not delete account.' });
  }
});

// Read account data and its current version.
app.get('/api/data', auth, async (req, res) => {
  try {
    const result = await db.execute({
      sql: `
        SELECT data, version
        FROM club_data
        WHERE user_id = ?
      `,
      args: [req.user.id]
    });

    const row = result.rows[0];

    res.json({
      data: row ? JSON.parse(row.data) : {},
      version: row ? row.version : 0
    });

  } catch (e) {
    console.error('Read account data error:', e);
    res.status(500).json({ error: 'Could not load account data.' });
  }
});

// Save account data only when the device has the latest version.
app.put('/api/data', auth, async (req, res) => {
  const { data, expectedVersion } = req.body || {};

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return res.status(400).json({ error: 'Invalid data.' });
  }

  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return res.status(400).json({
      error: 'A valid expectedVersion is required.'
    });
  }

  let tx;

  try {
    tx = await db.transaction('write');

    const result = await tx.execute({
      sql: `
        SELECT version
        FROM club_data
        WHERE user_id = ?
      `,
      args: [req.user.id]
    });

    const current = result.rows[0];
    const currentVersion = current ? current.version : 0;

    if (currentVersion !== expectedVersion) {
      await tx.rollback();
      tx = null;

      return res.status(409).json({
        error: 'This account was updated on another device. Your local changes have not been saved.',
        conflict: true,
        currentVersion
      });
    }

    let newVersion;

    if (!current) {
      await tx.execute({
        sql: `
          INSERT INTO club_data(user_id, data, version, updated_at)
          VALUES(?,?,1,CURRENT_TIMESTAMP)
        `,
        args: [req.user.id, JSON.stringify(data)]
      });

      newVersion = 1;

    } else {
      const update = await tx.execute({
        sql: `
          UPDATE club_data
          SET data = ?,
              version = version + 1,
              updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ? AND version = ?
        `,
        args: [
          JSON.stringify(data),
          req.user.id,
          expectedVersion
        ]
      });

      if (!update.rowsAffected) {
        const latest = await tx.execute({
          sql: `
            SELECT version
            FROM club_data
            WHERE user_id = ?
          `,
          args: [req.user.id]
        });

        const latestVersion = latest.rows[0]?.version ?? 0;

        await tx.rollback();
        tx = null;

        return res.status(409).json({
          error: 'This account was updated on another device. Your local changes have not been saved.',
          conflict: true,
          currentVersion: latestVersion
        });
      }

      newVersion = expectedVersion + 1;
    }

    await tx.commit();
    tx = null;

    res.json({ ok: true, version: newVersion });

  } catch (e) {
    if (tx) {
      try { await tx.rollback(); } catch {}
    }

    console.error('Save account data error:', e);
    res.status(500).json({ error: 'Could not save account data.' });
  }
});

// Health check, including the cloud database connection.
app.get('/api/health', async (req, res) => {
  try {
    await db.execute('SELECT 1 AS connected');

    res.json({
      status: 'ok',
      database: 'connected'
    });

  } catch (e) {
    console.error('Health check error:', e);

    res.status(503).json({
      status: 'error',
      database: 'unavailable'
    });
  }
});

// Serve frontend
const dist = path.join(__dirname, '../dist');

app.use(express.static(dist));

app.get('*', (req, res) => {
  res.sendFile(path.join(dist, 'index.html'));
});

// Start only after the cloud database is initialized.
const port = process.env.PORT || 5000;

try {
  await initializeDatabase();

  app.listen(port, '0.0.0.0', () => {
    console.log(`Lion Dance Club server running on port ${port}`);
  });

} catch (e) {
  console.error('Could not start application:', e);
  await db.close();
  process.exit(1);
}
