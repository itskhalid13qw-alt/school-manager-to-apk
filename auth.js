'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { db, DATA_DIR } = require('./db');

// Secret comes from JWT_SECRET, otherwise a random one is created once and kept in the data folder.
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(DATA_DIR, 'secret.key');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
const SECRET = loadSecret();

function sign(user) {
  return jwt.sign(
    { id: user.id, username: user.username, name: user.full_name, role: user.role },
    SECRET,
    { expiresIn: '12h' }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Please sign in.' });
  try {
    const payload = jwt.verify(token, SECRET);
    const row = db.prepare('SELECT id, role, active, teacher_id FROM users WHERE id = ?').get(payload.id);
    if (!row || !row.active) return res.status(401).json({ error: 'This account is no longer active.' });
    req.user = { ...payload, role: row.role, teacher_id: row.teacher_id }; // role and link are read fresh from the database
    next();
  } catch {
    res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
  }
}

// allow('teacher') lets admins and teachers in. Admins always pass.
function allow(...roles) {
  return (req, res, next) => {
    if (req.user.role === 'admin' || roles.includes(req.user.role)) return next();
    res.status(403).json({ error: 'You do not have permission to do this.' });
  };
}

module.exports = { sign, requireAuth, allow };
