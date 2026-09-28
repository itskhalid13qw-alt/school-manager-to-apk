'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'school.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS teachers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_no        TEXT UNIQUE,
  name          TEXT NOT NULL,
  phone         TEXT DEFAULT '',
  email         TEXT DEFAULT '',
  qualification TEXT DEFAULT '',
  subject       TEXT DEFAULT '',
  joined_on     TEXT DEFAULT '',
  monthly_salary INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','left'))
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','teacher','accountant')),
  active        INTEGER NOT NULL DEFAULT 1,
  teacher_id    INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
  last_login    TEXT
);

CREATE TABLE IF NOT EXISTS classes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  section     TEXT NOT NULL DEFAULT '',
  teacher_id  INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
  monthly_fee INTEGER NOT NULL DEFAULT 0,
  UNIQUE (name, section)
);

CREATE TABLE IF NOT EXISTS subjects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id    INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  total_marks INTEGER NOT NULL DEFAULT 100,
  UNIQUE (class_id, name)
);

CREATE TABLE IF NOT EXISTS students (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  admission_no TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  father_name  TEXT NOT NULL DEFAULT '',
  gender       TEXT NOT NULL DEFAULT 'Male',
  dob          TEXT DEFAULT '',
  phone        TEXT DEFAULT '',
  address      TEXT DEFAULT '',
  class_id     INTEGER NOT NULL REFERENCES classes(id),
  admitted_on  TEXT DEFAULT '',
  fee_discount INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','left'))
);
CREATE INDEX IF NOT EXISTS idx_students_class ON students(class_id);

CREATE TABLE IF NOT EXISTS attendance (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('P','A','L')),
  UNIQUE (student_id, date)
);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date);

CREATE TABLE IF NOT EXISTS exams (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  term     TEXT DEFAULT '',
  held_on  TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS marks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id    INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  obtained   REAL NOT NULL,
  UNIQUE (exam_id, student_id, subject_id)
);

CREATE TABLE IF NOT EXISTS fee_vouchers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  month      TEXT NOT NULL,
  amount     INTEGER NOT NULL,
  discount   INTEGER NOT NULL DEFAULT 0,
  due_date   TEXT DEFAULT '',
  UNIQUE (student_id, month)
);

CREATE TABLE IF NOT EXISTS salary_vouchers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id  INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  month       TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  deduction   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (teacher_id, month)
);

CREATE TABLE IF NOT EXISTS salary_payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_id  INTEGER NOT NULL REFERENCES salary_vouchers(id) ON DELETE CASCADE,
  amount      INTEGER NOT NULL CHECK (amount > 0),
  paid_on     TEXT NOT NULL,
  method      TEXT NOT NULL DEFAULT 'Cash',
  note        TEXT DEFAULT '',
  paid_by     TEXT DEFAULT '',
  receipt_no  TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS fee_payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_id  INTEGER NOT NULL REFERENCES fee_vouchers(id) ON DELETE CASCADE,
  amount      INTEGER NOT NULL CHECK (amount > 0),
  paid_on     TEXT NOT NULL,
  method      TEXT NOT NULL DEFAULT 'Cash',
  note        TEXT DEFAULT '',
  received_by TEXT DEFAULT '',
  receipt_no  TEXT DEFAULT ''
);
`);

// ---- Upgrade older databases -------------------------------------------------
const teacherCols = db.prepare('PRAGMA table_info(teachers)').all().map((c) => c.name);
if (!teacherCols.includes('monthly_salary')) db.exec('ALTER TABLE teachers ADD COLUMN monthly_salary INTEGER NOT NULL DEFAULT 0');
const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userCols.includes('teacher_id')) {
  db.exec('ALTER TABLE users ADD COLUMN teacher_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL');
}
if (!userCols.includes('last_login')) db.exec('ALTER TABLE users ADD COLUMN last_login TEXT');

// ---- First-run seed -------------------------------------------------------
const hasUsers = db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0;
if (!hasUsers) {
  const pw = process.env.ADMIN_PASSWORD || 'admin123';
  db.prepare(
    "INSERT INTO users (username, password_hash, full_name, role) VALUES ('admin', ?, 'Administrator', 'admin')"
  ).run(bcrypt.hashSync(pw, 10));
  console.log('Created default login  ->  username: admin   password: ' + pw);
}
const defaults = {
  school_name: 'My School',
  school_address: '',
  school_phone: '',
};
const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(defaults)) ins.run(k, v);

module.exports = { db, DATA_DIR };
