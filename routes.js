'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const { sign, requireAuth, allow } = require('./auth');

const router = express.Router();

/* ---------- helpers ---------- */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);
const notFound = (what = 'Record') => new HttpError(404, `${what} not found.`);
const str = (v) => (v == null ? '' : String(v).trim());
const int = (v, def = 0) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 ? n : def; };
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(str(v));
const isMonth = (v) => /^\d{4}-\d{2}$/.test(str(v));
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const need = (body, fields) => {
  for (const f of fields) if (!str(body[f])) throw bad(`${f.replace(/_/g, ' ')} is required.`);
};
const CLASS_LABEL = "trim(c.name || ' ' || c.section)";
// Sorts "Class 2" before "Class 10"; names without a number (Nursery, KG) come first.
const CLASS_ORDER = "CAST(trim(replace(replace(c.name, 'Class', ''), 'Grade', '')) AS INTEGER), c.name, c.section";

function getSettings() {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

function gradeFor(pct) {
  if (pct >= 80) return 'A1';
  if (pct >= 70) return 'A';
  if (pct >= 60) return 'B';
  if (pct >= 50) return 'C';
  if (pct >= 40) return 'D';
  if (pct >= 33) return 'E';
  return 'F';
}

/* A teacher login that is linked to a teacher record only works with the classes that teacher is
   class teacher of. myClassIds returns null when there is no restriction (admin, accountant, or a
   teacher login that has not been linked yet). */
function myClassIds(user) {
  if (user.role !== 'teacher' || !user.teacher_id) return null;
  return db.prepare('SELECT id FROM classes WHERE teacher_id = ?').all(user.teacher_id).map((r) => r.id);
}
function assertClass(req, classId) {
  const ids = myClassIds(req.user);
  if (ids && !ids.includes(Number(classId))) throw new HttpError(403, 'This class is not assigned to you.');
}
const inList = (ids) => ids.map(() => '?').join(',') || 'NULL';

/* ---------- auth (public) ---------- */
router.get('/health', (req, res) => res.json({ ok: true }));

const ROLE_NAME = { admin: 'Administrator', teacher: 'Teacher', accountant: 'Accountant' };
const attempts = new Map();
router.post('/auth/login', (req, res) => {
  const key = req.ip;
  const now = Date.now();
  const a = attempts.get(key) || { n: 0, t: now };
  if (now - a.t > 15 * 60 * 1000) { a.n = 0; a.t = now; }
  if (a.n >= 10) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
  const { username, password, portal } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(str(username).toLowerCase());
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) {
    a.n++; attempts.set(key, a);
    throw new HttpError(401, 'Wrong username or password.');
  }
  // The sign-in page has one tab per part of the system. A login only works from its own tab.
  if (['admin', 'teacher', 'accountant'].includes(portal) && portal !== u.role) {
    throw new HttpError(403, `This login belongs to the ${ROLE_NAME[u.role]} part. Choose the ${ROLE_NAME[u.role]} tab and sign in again.`);
  }
  attempts.delete(key);
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(new Date().toISOString(), u.id);
  res.json({
    token: sign(u),
    user: { id: u.id, username: u.username, name: u.full_name, role: u.role },
    school: getSettings(),
  });
});

router.use(requireAuth);

router.get('/auth/me', (req, res) => {
  res.json({ user: { id: req.user.id, username: req.user.username, name: req.user.name, role: req.user.role }, school: getSettings() });
});

router.post('/auth/password', (req, res) => {
  const { current, next } = req.body || {};
  if (str(next).length < 6) throw bad('New password must be at least 6 characters.');
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(String(current || ''), u.password_hash)) throw bad('Current password is wrong.');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(next), 10), u.id);
  res.json({ ok: true });
});

/* ---------- settings ---------- */
router.get('/settings', (req, res) => res.json(getSettings()));
router.put('/settings', allow(), (req, res) => {
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const k of ['school_name', 'school_address', 'school_phone']) {
    if (req.body[k] !== undefined) up.run(k, str(req.body[k]));
  }
  res.json(getSettings());
});

/* ---------- dashboard ---------- */
function studentsWithoutVoucher(month) {
  return db.prepare(`SELECT COUNT(*) n FROM students s JOIN classes cl ON cl.id = s.class_id
    WHERE s.status = 'active' AND cl.monthly_fee > 0
    AND NOT EXISTS (SELECT 1 FROM fee_vouchers v WHERE v.student_id = s.id AND v.month = ?)`).get(month).n;
}

function adminAttention(today, month) {
  const items = [];
  const q = (sql, ...a) => db.prepare(sql).get(...a).n;
  const add = (n, one, many, href) => { if (n > 0) items.push({ text: (n === 1 ? one : many).replace('{n}', n), href }); };
  add(q("SELECT COUNT(*) n FROM classes c WHERE c.monthly_fee = 0 AND EXISTS (SELECT 1 FROM students s WHERE s.class_id = c.id AND s.status = 'active')"),
    '{n} class with students has no monthly fee', '{n} classes with students have no monthly fee', '#/classes');
  add(q("SELECT COUNT(*) n FROM teachers WHERE status = 'active' AND monthly_salary = 0"),
    '{n} teacher has no monthly salary set', '{n} teachers have no monthly salary set', '#/teachers');
  add(q('SELECT COUNT(*) n FROM classes c WHERE NOT EXISTS (SELECT 1 FROM subjects x WHERE x.class_id = c.id)'),
    '{n} class has no subjects yet', '{n} classes have no subjects yet', '#/classes');
  add(q('SELECT COUNT(*) n FROM classes WHERE teacher_id IS NULL'),
    '{n} class has no class teacher', '{n} classes have no class teacher', '#/classes');
  add(q("SELECT COUNT(*) n FROM users WHERE role = 'teacher' AND active = 1 AND teacher_id IS NULL"),
    '{n} teacher login is not linked to a teacher record', '{n} teacher logins are not linked to a teacher record', '#/control');
  add(q("SELECT COUNT(*) n FROM teachers t WHERE t.status = 'active' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.teacher_id = t.id)"),
    '{n} teacher has no login yet', '{n} teachers have no login yet', '#/control');
  add(studentsWithoutVoucher(month), '{n} student has no fee voucher for this month', '{n} students have no fee voucher for this month', '#/fees');
  if (new Date().getDay() !== 0) {
    add(q(`SELECT COUNT(*) n FROM classes c WHERE EXISTS (SELECT 1 FROM students s WHERE s.class_id = c.id AND s.status = 'active')
      AND NOT EXISTS (SELECT 1 FROM attendance a JOIN students s ON s.id = a.student_id WHERE s.class_id = c.id AND a.date = ?)`, today),
      'Attendance is not marked today for {n} class', 'Attendance is not marked today for {n} classes', '#/attendance');
  }
  return items;
}

function teacherDashboard(req, today) {
  const ids = myClassIds(req.user);
  const linked = ids !== null;
  const classes = linked
    ? (ids.length ? db.prepare(`SELECT c.id, ${CLASS_LABEL} AS label FROM classes c WHERE c.id IN (${inList(ids)}) ORDER BY ${CLASS_ORDER}`).all(...ids) : [])
    : db.prepare(`SELECT c.id, ${CLASS_LABEL} AS label FROM classes c ORDER BY ${CLASS_ORDER}`).all();
  const teacher = req.user.teacher_id ? db.prepare('SELECT name FROM teachers WHERE id = ?').get(req.user.teacher_id) : null;
  const myClasses = classes.map((c) => {
    const students = db.prepare("SELECT COUNT(*) n FROM students WHERE class_id = ? AND status = 'active'").get(c.id).n;
    const subjects = db.prepare('SELECT COUNT(*) n FROM subjects WHERE class_id = ?').get(c.id).n;
    const attendance = { P: 0, A: 0, L: 0 };
    for (const r of db.prepare(`SELECT a.status, COUNT(*) n FROM attendance a JOIN students s ON s.id = a.student_id
      WHERE s.class_id = ? AND a.date = ? GROUP BY a.status`).all(c.id, today)) attendance[r.status] = r.n;
    const exams = db.prepare('SELECT id, name FROM exams WHERE class_id = ? ORDER BY id DESC LIMIT 3').all(c.id).map((e) => ({
      ...e,
      entered: db.prepare('SELECT COUNT(*) n FROM marks WHERE exam_id = ?').get(e.id).n,
      expected: students * subjects,
    }));
    return { ...c, students, subjects, attendance, marked: attendance.P + attendance.A + attendance.L > 0, exams };
  });
  return { role: 'teacher', linked, teacherName: teacher ? teacher.name : '', myClasses };
}

router.get('/dashboard', (req, res) => {
  const today = todayISO();
  const month = today.slice(0, 7);
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const role = req.user.role;
  if (role === 'teacher') return res.json(teacherDashboard(req, today));

  const out = {
    role,
    month,
    students: one("SELECT COUNT(*) c FROM students WHERE status = 'active'").c,
    teachers: one("SELECT COUNT(*) c FROM teachers WHERE status = 'active'").c,
    classes: one('SELECT COUNT(*) c FROM classes').c,
    attendanceToday: { P: 0, A: 0, L: 0 },
    classStrength: db.prepare(`
      SELECT c.id, ${CLASS_LABEL} AS label, COUNT(s.id) AS n
      FROM classes c LEFT JOIN students s ON s.class_id = c.id AND s.status = 'active'
      GROUP BY c.id ORDER BY ${CLASS_ORDER}`).all(),
  };
  for (const r of db.prepare('SELECT status, COUNT(*) c FROM attendance WHERE date = ? GROUP BY status').all(today)) {
    out.attendanceToday[r.status] = r.c;
  }
  out.collectedThisMonth = one('SELECT COALESCE(SUM(amount),0) s FROM fee_payments WHERE paid_on LIKE ?', month + '%').s;
  out.outstanding = one(`
    SELECT COALESCE(SUM(v.amount - v.discount - COALESCE(p.paid,0)),0) s
    FROM fee_vouchers v
    LEFT JOIN (SELECT voucher_id, SUM(amount) paid FROM fee_payments GROUP BY voucher_id) p ON p.voucher_id = v.id`).s;
  out.latestPayments = db.prepare(`
    SELECT p.id, p.amount, p.paid_on, p.receipt_no, s.name AS student_name, v.month
    FROM fee_payments p JOIN fee_vouchers v ON v.id = p.voucher_id JOIN students s ON s.id = v.student_id
    ORDER BY p.id DESC LIMIT 6`).all();

  if (role === 'accountant') {
    const t = one('SELECT COUNT(*) n, COALESCE(SUM(amount),0) total FROM fee_payments WHERE paid_on = ?', today);
    out.today = { count: t.n, total: t.total };
    out.unpaidThisMonth = one(`SELECT COUNT(*) n FROM (${VOUCHER_SQL}) WHERE month = ? AND balance > 0`, month).n;
    out.noVouchers = studentsWithoutVoucher(month);
    out.defaulters = one(`SELECT COUNT(*) n FROM (SELECT student_id FROM (${VOUCHER_SQL}) WHERE balance > 0 GROUP BY student_id)`).n;
  } else {
    out.attention = adminAttention(today, month);
  }
  res.json(out);
});

/* ---------- teachers ---------- */
const teacherVals = (b) => [
  str(b.name), str(b.phone), str(b.email), str(b.qualification), str(b.subject), str(b.joined_on),
  int(b.monthly_salary), b.status === 'left' ? 'left' : 'active',
];
function nextEmpNo() {
  let n = db.prepare('SELECT COALESCE(MAX(id),0)+1 n FROM teachers').get().n;
  let no;
  do { no = 'T-' + String(n++).padStart(3, '0'); } while (db.prepare('SELECT 1 FROM teachers WHERE emp_no = ?').get(no));
  return no;
}
router.get('/teachers', allow(), (req, res) => {
  const q = `%${str(req.query.q)}%`;
  const status = req.query.status || 'active';
  const rows = db.prepare(`
    SELECT * FROM teachers
    WHERE (name LIKE ? OR emp_no LIKE ? OR subject LIKE ?) AND (? = 'all' OR status = ?)
    ORDER BY name`).all(q, q, q, status, status);
  res.json(rows);
});
router.post('/teachers/import', allow(), (req, res) => {
  const rows = req.body && req.body.rows;
  if (!Array.isArray(rows) || !rows.length) throw bad('The file has no teacher rows.');
  if (rows.length > 1000) throw bad('Import at most 1000 teachers at a time.');
  const ins = db.prepare(`INSERT INTO teachers (emp_no, name, phone, email, qualification, subject, joined_on, monthly_salary, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const firstRow = Number(req.body.first_row) || 2;
  const errors = [];
  let added = 0;
  db.transaction(() => {
    rows.forEach((r, i) => {
      try {
        if (!str(r.name)) throw new Error('name is missing');
        const status = /^(left|resigned|inactive|former)/i.test(str(r.status)) ? 'left' : 'active';
        ins.run(str(r.emp_no) || nextEmpNo(), str(r.name), str(r.phone), str(r.email), str(r.qualification),
          str(r.subject), isDate(r.joined_on) ? str(r.joined_on) : '', int(r.monthly_salary), status);
        added++;
      } catch (e) {
        errors.push(`Row ${i + firstRow}: ` + (String(e.message).includes('UNIQUE') ? 'employee number already exists' : e.message));
      }
    });
  })();
  res.json({ added, failed: errors.length, errors: errors.slice(0, 40) });
});
router.post('/teachers', allow(), (req, res) => {
  need(req.body, ['name']);
  const emp = str(req.body.emp_no) || nextEmpNo();
  const info = db.prepare(`INSERT INTO teachers (emp_no, name, phone, email, qualification, subject, joined_on, monthly_salary, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(emp, ...teacherVals(req.body));
  res.status(201).json(db.prepare('SELECT * FROM teachers WHERE id = ?').get(info.lastInsertRowid));
});
router.put('/teachers/:id', allow(), (req, res) => {
  need(req.body, ['name']);
  const emp = str(req.body.emp_no);
  if (!emp) throw bad('emp no is required.');
  const info = db.prepare(`UPDATE teachers SET emp_no=?, name=?, phone=?, email=?, qualification=?, subject=?, joined_on=?, monthly_salary=?, status=? WHERE id=?`)
    .run(emp, ...teacherVals(req.body), req.params.id);
  if (!info.changes) throw notFound('Teacher');
  res.json(db.prepare('SELECT * FROM teachers WHERE id = ?').get(req.params.id));
});
router.delete('/teachers/:id', allow(), (req, res) => {
  const info = db.prepare('DELETE FROM teachers WHERE id = ?').run(req.params.id);
  if (!info.changes) throw notFound('Teacher');
  res.json({ ok: true });
});

/* ---------- classes & subjects ---------- */
const classSelect = `
  SELECT c.id, c.name, c.section, c.teacher_id, c.monthly_fee, ${CLASS_LABEL} AS label,
    t.name AS teacher_name,
    (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id AND s.status = 'active') AS student_count,
    (SELECT COUNT(*) FROM subjects x WHERE x.class_id = c.id) AS subject_count
  FROM classes c LEFT JOIN teachers t ON t.id = c.teacher_id`;
router.get('/classes', (req, res) => {
  const ids = myClassIds(req.user);
  if (ids) {
    if (!ids.length) return res.json([]);
    return res.json(db.prepare(`${classSelect} WHERE c.id IN (${inList(ids)}) ORDER BY ${CLASS_ORDER}`).all(...ids));
  }
  res.json(db.prepare(classSelect + ' ORDER BY ' + CLASS_ORDER).all());
});
router.post('/classes', allow(), (req, res) => {
  need(req.body, ['name']);
  const info = db.prepare('INSERT INTO classes (name, section, teacher_id, monthly_fee) VALUES (?, ?, ?, ?)')
    .run(str(req.body.name), str(req.body.section), req.body.teacher_id || null, int(req.body.monthly_fee));
  res.status(201).json(db.prepare(classSelect + ' WHERE c.id = ?').get(info.lastInsertRowid));
});
router.post('/classes/fees', allow(), (req, res) => {
  const fees = req.body && req.body.fees;
  if (!Array.isArray(fees) || !fees.length) throw bad('No fees were sent.');
  const up = db.prepare('UPDATE classes SET monthly_fee = ? WHERE id = ?');
  db.transaction(() => {
    for (const f of fees) {
      const n = Math.round(Number(f.monthly_fee));
      if (!Number.isFinite(n) || n < 0) throw bad('Each fee must be zero or more.');
      up.run(n, f.id);
    }
  })();
  res.json({ ok: true });
});
router.put('/classes/:id', allow(), (req, res) => {
  need(req.body, ['name']);
  const info = db.prepare('UPDATE classes SET name=?, section=?, teacher_id=?, monthly_fee=? WHERE id=?')
    .run(str(req.body.name), str(req.body.section), req.body.teacher_id || null, int(req.body.monthly_fee), req.params.id);
  if (!info.changes) throw notFound('Class');
  res.json(db.prepare(classSelect + ' WHERE c.id = ?').get(req.params.id));
});
router.delete('/classes/:id', allow(), (req, res) => {
  const n = db.prepare('SELECT COUNT(*) c FROM students WHERE class_id = ?').get(req.params.id).c;
  if (n) throw bad('This class still has students. Move or remove them first.');
  const info = db.prepare('DELETE FROM classes WHERE id = ?').run(req.params.id);
  if (!info.changes) throw notFound('Class');
  res.json({ ok: true });
});

router.get('/classes/:id/subjects', (req, res) => {
  assertClass(req, req.params.id);
  res.json(db.prepare('SELECT * FROM subjects WHERE class_id = ? ORDER BY id').all(req.params.id));
});
router.post('/classes/:id/subjects', allow(), (req, res) => {
  need(req.body, ['name']);
  const total = int(req.body.total_marks, 100) || 100;
  const info = db.prepare('INSERT INTO subjects (class_id, name, total_marks) VALUES (?, ?, ?)').run(req.params.id, str(req.body.name), total);
  res.status(201).json(db.prepare('SELECT * FROM subjects WHERE id = ?').get(info.lastInsertRowid));
});
router.post('/classes/:id/subjects/copy', allow(), (req, res) => {
  const fromId = Number(req.params.id);
  const targets = [...new Set(((req.body && req.body.to_class_ids) || []).map(Number))].filter((n) => n && n !== fromId);
  if (!targets.length) throw bad('Choose at least one class to copy to.');
  const source = db.prepare('SELECT name, total_marks FROM subjects WHERE class_id = ? ORDER BY id').all(fromId);
  if (!source.length) throw bad('This class has no subjects to copy yet.');
  const exists = db.prepare('SELECT 1 FROM classes WHERE id = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO subjects (class_id, name, total_marks) VALUES (?, ?, ?)');
  let added = 0, skipped = 0, classes = 0;
  db.transaction(() => {
    for (const cid of targets) {
      if (!exists.get(cid)) continue;
      classes++;
      for (const sub of source) (ins.run(cid, sub.name, sub.total_marks).changes ? added++ : skipped++);
    }
  })();
  res.json({ added, skipped, classes });
});
router.put('/subjects/:id', allow(), (req, res) => {
  need(req.body, ['name']);
  const total = int(req.body.total_marks, 100) || 100;
  const info = db.prepare('UPDATE subjects SET name = ?, total_marks = ? WHERE id = ?').run(str(req.body.name), total, req.params.id);
  if (!info.changes) throw notFound('Subject');
  res.json(db.prepare('SELECT * FROM subjects WHERE id = ?').get(req.params.id));
});
router.delete('/subjects/:id', allow(), (req, res) => {
  db.prepare('DELETE FROM subjects WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* ---------- students ---------- */
const studentSelect = `
  SELECT s.*, ${CLASS_LABEL} AS class_name
  FROM students s JOIN classes c ON c.id = s.class_id`;
function nextAdmissionNo() {
  let n = db.prepare('SELECT COALESCE(MAX(id),0)+1 n FROM students').get().n;
  let no;
  do { no = String(n++).padStart(4, '0'); } while (db.prepare('SELECT 1 FROM students WHERE admission_no = ?').get(no));
  return no;
}
function studentVals(b) {
  const cls = db.prepare('SELECT id FROM classes WHERE id = ?').get(b.class_id);
  if (!cls) throw bad('Choose a valid class.');
  return [
    str(b.name), str(b.father_name), b.gender === 'Female' ? 'Female' : 'Male', str(b.dob), str(b.phone),
    str(b.address), cls.id, str(b.admitted_on), int(b.fee_discount), b.status === 'left' ? 'left' : 'active',
  ];
}
router.get('/students', (req, res) => {
  const where = [];
  const args = [];
  const q = str(req.query.q);
  if (q) {
    where.push('(s.name LIKE ? OR s.father_name LIKE ? OR s.admission_no LIKE ? OR s.phone LIKE ?)');
    args.push(...Array(4).fill(`%${q}%`));
  }
  if (req.query.class_id) { where.push('s.class_id = ?'); args.push(req.query.class_id); }
  const mine = myClassIds(req.user);
  if (mine) {
    if (!mine.length) return res.json([]);
    where.push(`s.class_id IN (${inList(mine)})`);
    args.push(...mine);
  }
  const status = req.query.status || 'active';
  if (status !== 'all') { where.push('s.status = ?'); args.push(status); }
  const sql = `${studentSelect} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${CLASS_ORDER}, s.name LIMIT 3000`;
  res.json(db.prepare(sql).all(...args));
});
router.post('/students/import', allow(), (req, res) => {
  const rows = req.body && req.body.rows;
  if (!Array.isArray(rows) || !rows.length) throw bad('The file has no student rows.');
  if (rows.length > 3000) throw bad('Import at most 3000 students at a time.');
  // "Class 5 A", "class 5-a", "5A" all become "5a"; "Class 5" and "5" become "5".
  const key = (v) => str(v).toLowerCase().replace(/\b(class|grade|std|standard|section)\b/g, '').replace(/[^a-z0-9\u0600-\u06ff]/g, '');
  const allClasses = db.prepare('SELECT id, name, section, ' + CLASS_LABEL + ' AS label FROM classes c ORDER BY ' + CLASS_ORDER).all();
  const exact = new Map(allClasses.map((c) => [key(c.label), c.id]));
  const byName = new Map();
  for (const c of allClasses) { const k = key(c.name); byName.set(k, [...(byName.get(k) || []), c.id]); }
  const createClasses = !!(req.body && req.body.create_classes);
  const created = [];
  const findClass = (v) => {
    const k = key(v);
    if (!k) throw new Error('class is missing');
    if (exact.has(k)) return exact.get(k);
    const ids = byName.get(k);
    if (ids && ids.length === 1) return ids[0];
    if (ids && ids.length > 1) throw new Error(`class "${str(v)}" has several sections. Write the section too, for example "${allClasses.find((c) => c.id === ids[0]).label}"`);
    if (createClasses) return createClass(v);
    throw new Error(`class "${str(v)}" does not exist. Add it in Classes first`);
  };
  const createClass = (v) => {
    const raw = str(v);
    const m = raw.match(/^(.*\d)\s*[-\s]\s*([A-Za-z])$/); // "Class 5 A" or "5-B" -> name + section
    const name = m ? m[1].trim() : /^\d+$/.test(raw) ? 'Class ' + raw : raw;
    const section = m ? m[2].toUpperCase() : '';
    const id = db.prepare('INSERT INTO classes (name, section, teacher_id, monthly_fee) VALUES (?, ?, NULL, 0)').run(name, section).lastInsertRowid;
    const label = (name + ' ' + section).trim();
    allClasses.push({ id, name, section, label });
    exact.set(key(label), id);
    byName.set(key(name), [...(byName.get(key(name)) || []), id]);
    created.push(label);
    return id;
  };
  const ins = db.prepare(`INSERT INTO students
    (admission_no, name, father_name, gender, dob, phone, address, class_id, admitted_on, fee_discount, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`);
  const errors = [];
  let added = 0;
  db.transaction(() => {
    rows.forEach((r, i) => {
      try {
        if (!str(r.name)) throw new Error('name is missing');
        const cid = findClass(r.class);
        const gender = /^f/i.test(str(r.gender)) ? 'Female' : 'Male';
        ins.run(str(r.admission_no) || nextAdmissionNo(), str(r.name), str(r.father_name), gender, str(r.dob),
          str(r.phone), str(r.address), cid, isDate(r.admitted_on) ? str(r.admitted_on) : todayISO(), int(r.fee_discount));
        added++;
      } catch (e) {
        errors.push(`Row ${i + (Number(req.body.first_row) || 2)}: ` + (String(e.message).includes('UNIQUE') ? 'admission number already exists' : e.message));
      }
    });
  })();
  res.json({ added, failed: errors.length, errors: errors.slice(0, 40), classes: allClasses.map((c) => c.label), created_classes: created });
});
router.get('/students/:id', (req, res) => {
  const s = db.prepare(studentSelect + ' WHERE s.id = ?').get(req.params.id);
  if (!s) throw notFound('Student');
  assertClass(req, s.class_id);
  res.json(s);
});
router.post('/students', allow(), (req, res) => {
  need(req.body, ['name', 'class_id']);
  const adm = str(req.body.admission_no) || nextAdmissionNo();
  const info = db.prepare(`INSERT INTO students
    (admission_no, name, father_name, gender, dob, phone, address, class_id, admitted_on, fee_discount, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(adm, ...studentVals(req.body));
  res.status(201).json(db.prepare(studentSelect + ' WHERE s.id = ?').get(info.lastInsertRowid));
});
router.put('/students/:id', allow(), (req, res) => {
  need(req.body, ['name', 'class_id', 'admission_no']);
  const info = db.prepare(`UPDATE students SET admission_no=?, name=?, father_name=?, gender=?, dob=?, phone=?, address=?,
    class_id=?, admitted_on=?, fee_discount=?, status=? WHERE id=?`)
    .run(str(req.body.admission_no), ...studentVals(req.body), req.params.id);
  if (!info.changes) throw notFound('Student');
  res.json(db.prepare(studentSelect + ' WHERE s.id = ?').get(req.params.id));
});
router.delete('/students/:id', allow(), (req, res) => {
  const info = db.prepare('DELETE FROM students WHERE id = ?').run(req.params.id);
  if (!info.changes) throw notFound('Student');
  res.json({ ok: true });
});

/* ---------- attendance ---------- */
router.get('/attendance', allow('teacher'), (req, res) => {
  const { class_id, date } = req.query;
  if (!class_id || !isDate(date)) throw bad('Choose a class and a date.');
  assertClass(req, class_id);
  const rows = db.prepare(`
    SELECT s.id, s.name, s.admission_no, a.status
    FROM students s LEFT JOIN attendance a ON a.student_id = s.id AND a.date = ?
    WHERE s.class_id = ? AND s.status = 'active' ORDER BY s.name`).all(date, class_id);
  res.json({ marked: rows.some((r) => r.status), students: rows });
});
router.post('/attendance', allow('teacher'), (req, res) => {
  const { class_id, date, records } = req.body || {};
  if (!class_id || !isDate(date) || !Array.isArray(records)) throw bad('Choose a class and a date.');
  assertClass(req, class_id);
  const inClass = new Set(db.prepare("SELECT id FROM students WHERE class_id = ? AND status = 'active'").all(class_id).map((r) => r.id));
  const up = db.prepare(`INSERT INTO attendance (student_id, date, status) VALUES (?, ?, ?)
    ON CONFLICT(student_id, date) DO UPDATE SET status = excluded.status`);
  db.transaction(() => {
    for (const r of records) {
      if (!inClass.has(Number(r.student_id))) continue;
      if (!['P', 'A', 'L'].includes(r.status)) throw bad('Status must be P, A or L.');
      up.run(r.student_id, date, r.status);
    }
  })();
  res.json({ ok: true });
});
router.get('/attendance/report', allow('teacher'), (req, res) => {
  const { class_id, month } = req.query;
  if (!class_id || !isMonth(month)) throw bad('Choose a class and a month.');
  assertClass(req, class_id);
  const rows = db.prepare(`
    SELECT s.id, s.name, s.admission_no,
      COALESCE(SUM(a.status = 'P'), 0) AS p,
      COALESCE(SUM(a.status = 'A'), 0) AS a,
      COALESCE(SUM(a.status = 'L'), 0) AS l,
      COUNT(a.id) AS total
    FROM students s LEFT JOIN attendance a ON a.student_id = s.id AND a.date LIKE ?
    WHERE s.class_id = ? AND s.status = 'active' GROUP BY s.id ORDER BY s.name`).all(month + '%', class_id);
  const days = db.prepare(`
    SELECT COUNT(DISTINCT a.date) d FROM attendance a JOIN students s ON s.id = a.student_id
    WHERE s.class_id = ? AND a.date LIKE ?`).get(class_id, month + '%').d;
  res.json({ days, students: rows });
});

/* ---------- exams & results ---------- */
function getExam(id) {
  const e = db.prepare(`SELECT e.*, ${CLASS_LABEL} AS class_name FROM exams e JOIN classes c ON c.id = e.class_id WHERE e.id = ?`).get(id);
  if (!e) throw notFound('Exam');
  return e;
}
router.get('/exams', allow('teacher'), (req, res) => {
  const conds = [];
  const args = [];
  if (req.query.class_id) { conds.push('e.class_id = ?'); args.push(req.query.class_id); }
  const mine = myClassIds(req.user);
  if (mine) {
    if (!mine.length) return res.json([]);
    conds.push(`e.class_id IN (${inList(mine)})`);
    args.push(...mine);
  }
  res.json(db.prepare(`SELECT e.*, ${CLASS_LABEL} AS class_name FROM exams e JOIN classes c ON c.id = e.class_id
    ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY e.id DESC`).all(...args));
});
router.post('/exams', allow('teacher'), (req, res) => {
  need(req.body, ['name', 'class_id']);
  assertClass(req, req.body.class_id);
  if (!db.prepare('SELECT 1 FROM classes WHERE id = ?').get(req.body.class_id)) throw bad('Choose a valid class.');
  const info = db.prepare('INSERT INTO exams (name, class_id, term, held_on) VALUES (?, ?, ?, ?)')
    .run(str(req.body.name), req.body.class_id, str(req.body.term), str(req.body.held_on));
  res.status(201).json(getExam(info.lastInsertRowid));
});
router.delete('/exams/:id', allow(), (req, res) => {
  const info = db.prepare('DELETE FROM exams WHERE id = ?').run(req.params.id);
  if (!info.changes) throw notFound('Exam');
  res.json({ ok: true });
});
router.get('/exams/:id/sheet', allow('teacher'), (req, res) => {
  const exam = getExam(req.params.id);
  assertClass(req, exam.class_id);
  const subjects = db.prepare('SELECT * FROM subjects WHERE class_id = ? ORDER BY id').all(exam.class_id);
  const students = db.prepare("SELECT id, name, admission_no FROM students WHERE class_id = ? AND status = 'active' ORDER BY name").all(exam.class_id);
  const map = {};
  for (const m of db.prepare('SELECT student_id, subject_id, obtained FROM marks WHERE exam_id = ?').all(exam.id)) {
    (map[m.student_id] ||= {})[m.subject_id] = m.obtained;
  }
  res.json({ exam, subjects, students: students.map((s) => ({ ...s, marks: map[s.id] || {} })) });
});
router.post('/exams/:id/marks', allow('teacher'), (req, res) => {
  const exam = getExam(req.params.id);
  assertClass(req, exam.class_id);
  const entries = req.body && req.body.entries;
  if (!Array.isArray(entries)) throw bad('No marks were sent.');
  const totals = new Map(db.prepare('SELECT id, total_marks FROM subjects WHERE class_id = ?').all(exam.class_id).map((s) => [s.id, s.total_marks]));
  const inClass = new Set(db.prepare('SELECT id FROM students WHERE class_id = ?').all(exam.class_id).map((s) => s.id));
  const up = db.prepare(`INSERT INTO marks (exam_id, student_id, subject_id, obtained) VALUES (?, ?, ?, ?)
    ON CONFLICT(exam_id, student_id, subject_id) DO UPDATE SET obtained = excluded.obtained`);
  const del = db.prepare('DELETE FROM marks WHERE exam_id = ? AND student_id = ? AND subject_id = ?');
  db.transaction(() => {
    for (const e of entries) {
      const sid = Number(e.student_id), sub = Number(e.subject_id);
      if (!inClass.has(sid) || !totals.has(sub)) continue;
      if (e.obtained === '' || e.obtained == null) { del.run(exam.id, sid, sub); continue; }
      const n = Number(e.obtained);
      const max = totals.get(sub);
      if (!Number.isFinite(n) || n < 0 || n > max) throw bad(`Marks must be between 0 and ${max}.`);
      up.run(exam.id, sid, sub, n);
    }
  })();
  res.json({ ok: true });
});
router.get('/exams/:id/results', allow('teacher'), (req, res) => {
  const exam = getExam(req.params.id);
  assertClass(req, exam.class_id);
  const subjects = db.prepare('SELECT * FROM subjects WHERE class_id = ? ORDER BY id').all(exam.class_id);
  const students = db.prepare("SELECT id, name, father_name, admission_no FROM students WHERE class_id = ? AND status = 'active' ORDER BY name").all(exam.class_id);
  const map = {};
  for (const m of db.prepare('SELECT student_id, subject_id, obtained FROM marks WHERE exam_id = ?').all(exam.id)) {
    (map[m.student_id] ||= {})[m.subject_id] = m.obtained;
  }
  const rows = students.map((s) => {
    let total = 0, possible = 0, entered = 0, failedSubject = false;
    const subs = subjects.map((sub) => {
      const o = map[s.id] && map[s.id][sub.id];
      if (o != null) {
        total += o; possible += sub.total_marks; entered++;
        if (o < sub.total_marks * 0.33) failedSubject = true;
      }
      return { subject_id: sub.id, obtained: o == null ? null : o, total: sub.total_marks, grade: o == null ? '' : gradeFor((o / sub.total_marks) * 100) };
    });
    const pct = possible ? (total / possible) * 100 : 0;
    return {
      student_id: s.id, name: s.name, father_name: s.father_name, admission_no: s.admission_no,
      subjects: subs, total, possible, percentage: Math.round(pct * 100) / 100,
      grade: entered ? gradeFor(pct) : '',
      result: !entered ? '' : failedSubject || pct < 33 ? 'Fail' : 'Pass',
      complete: entered === subjects.length && subjects.length > 0,
    };
  });
  const ranked = rows.filter((r) => r.possible > 0).sort((a, b) => b.percentage - a.percentage);
  ranked.forEach((r, i) => { r.position = i > 0 && r.percentage === ranked[i - 1].percentage ? ranked[i - 1].position : i + 1; });
  res.json({ exam, subjects, results: rows });
});

/* ---------- fees ---------- */
const VOUCHER_SQL = `
  SELECT v.id, v.student_id, v.month, v.amount, v.discount, v.due_date,
    s.name AS student_name, s.admission_no, s.father_name, s.class_id, ${CLASS_LABEL} AS class_name,
    COALESCE(p.paid, 0) AS paid,
    (v.amount - v.discount - COALESCE(p.paid, 0)) AS balance
  FROM fee_vouchers v
  JOIN students s ON s.id = v.student_id
  JOIN classes c ON c.id = s.class_id
  LEFT JOIN (SELECT voucher_id, SUM(amount) paid FROM fee_payments GROUP BY voucher_id) p ON p.voucher_id = v.id`;
const METHODS = ['Cash', 'Bank transfer', 'JazzCash', 'Easypaisa', 'Cheque'];

function voucherDetail(id) {
  const v = db.prepare(`SELECT * FROM (${VOUCHER_SQL}) WHERE id = ?`).get(id);
  if (!v) throw notFound('Voucher');
  v.payments = db.prepare('SELECT * FROM fee_payments WHERE voucher_id = ? ORDER BY id').all(id);
  return v;
}

router.get('/fees', allow('accountant'), (req, res) => {
  const { month, class_id, status, q } = req.query;
  const where = [];
  const args = [];
  if (month) { where.push('month = ?'); args.push(month); }
  if (class_id) { where.push('class_id = ?'); args.push(class_id); }
  if (status === 'paid') where.push('balance <= 0');
  if (status === 'unpaid') where.push('balance > 0');
  if (str(q)) { where.push('(student_name LIKE ? OR admission_no LIKE ?)'); args.push(`%${str(q)}%`, `%${str(q)}%`); }
  res.json(db.prepare(`SELECT * FROM (${VOUCHER_SQL}) ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY class_id, student_name LIMIT 5000`).all(...args));
});
router.get('/fees/dues', allow('accountant'), (req, res) => {
  const args = [];
  let where = 'WHERE balance > 0';
  if (req.query.class_id) { where += ' AND class_id = ?'; args.push(req.query.class_id); }
  res.json(db.prepare(`
    SELECT student_id, student_name, admission_no, father_name, class_name,
      COUNT(*) AS months, SUM(balance) AS due, MIN(month) AS since
    FROM (${VOUCHER_SQL}) ${where}
    GROUP BY student_id ORDER BY due DESC`).all(...args));
});
router.post('/fees/generate', allow('accountant'), (req, res) => {
  const { month, class_id } = req.body || {};
  if (!isMonth(month)) throw bad('Choose a month.');
  const students = db.prepare(`
    SELECT s.id, s.fee_discount, c.monthly_fee FROM students s JOIN classes c ON c.id = s.class_id
    WHERE s.status = 'active' ${class_id ? 'AND s.class_id = ?' : ''}`).all(...(class_id ? [class_id] : []));
  const ins = db.prepare('INSERT OR IGNORE INTO fee_vouchers (student_id, month, amount, discount, due_date) VALUES (?, ?, ?, ?, ?)');
  let created = 0, skipped = 0, noFee = 0;
  db.transaction(() => {
    for (const s of students) {
      if (!s.monthly_fee) { noFee++; continue; }
      const r = ins.run(s.id, month, s.monthly_fee, Math.min(s.fee_discount, s.monthly_fee), month + '-10');
      r.changes ? created++ : skipped++;
    }
  })();
  res.json({ created, skipped, noFee });
});
router.get('/fees/collection', allow('accountant'), (req, res) => {
  const from = isDate(req.query.from) ? req.query.from : todayISO();
  const to = isDate(req.query.to) ? req.query.to : from;
  const rows = db.prepare(`
    SELECT p.id, p.receipt_no, p.amount, p.paid_on, p.method, p.received_by, p.note, v.month,
      s.name AS student_name, s.admission_no, ${CLASS_LABEL} AS class_name
    FROM fee_payments p
    JOIN fee_vouchers v ON v.id = p.voucher_id
    JOIN students s ON s.id = v.student_id
    JOIN classes c ON c.id = s.class_id
    WHERE p.paid_on BETWEEN ? AND ? ORDER BY p.paid_on, p.id`).all(from, to);
  const byMethod = {};
  for (const r of rows) {
    const m = (byMethod[r.method] ||= { method: r.method, count: 0, amount: 0 });
    m.count++; m.amount += r.amount;
  }
  res.json({ from, to, rows, total: rows.reduce((a, r) => a + r.amount, 0), byMethod: Object.values(byMethod) });
});
router.get('/fees/:id', allow('accountant'), (req, res) => res.json(voucherDetail(req.params.id)));
router.put('/fees/:id', allow(), (req, res) => {
  const amount = int(req.body.amount, -1);
  const discount = int(req.body.discount);
  if (amount < 0) throw bad('Enter a valid amount.');
  if (discount > amount) throw bad('Discount cannot be more than the amount.');
  const info = db.prepare('UPDATE fee_vouchers SET amount = ?, discount = ? WHERE id = ?').run(amount, discount, req.params.id);
  if (!info.changes) throw notFound('Voucher');
  res.json(voucherDetail(req.params.id));
});
router.post('/fees/:id/pay', allow('accountant'), (req, res) => {
  const v = voucherDetail(req.params.id);
  const amount = Math.round(Number(req.body.amount));
  if (!(amount > 0)) throw bad('Enter an amount greater than zero.');
  if (amount > v.balance) throw bad(`Amount is more than the balance of Rs ${v.balance}.`);
  const paidOn = isDate(req.body.paid_on) ? req.body.paid_on : todayISO();
  const method = METHODS.includes(req.body.method) ? req.body.method : 'Cash';
  const info = db.prepare('INSERT INTO fee_payments (voucher_id, amount, paid_on, method, note, received_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(v.id, amount, paidOn, method, str(req.body.note), req.user.name);
  db.prepare('UPDATE fee_payments SET receipt_no = ? WHERE id = ?').run('R-' + String(info.lastInsertRowid).padStart(5, '0'), info.lastInsertRowid);
  res.status(201).json(voucherDetail(v.id));
});
router.delete('/fees/payments/:id', allow(), (req, res) => {
  const p = db.prepare('SELECT voucher_id FROM fee_payments WHERE id = ?').get(req.params.id);
  if (!p) throw notFound('Payment');
  db.prepare('DELETE FROM fee_payments WHERE id = ?').run(req.params.id);
  res.json(voucherDetail(p.voucher_id));
});

/* ---------- payroll (admin) ---------- */
const SALARY_SQL = `
  SELECT sv.id, sv.teacher_id, sv.month, sv.amount, sv.deduction,
    t.name AS teacher_name, t.emp_no, t.subject,
    COALESCE(p.paid, 0) AS paid,
    (sv.amount - sv.deduction - COALESCE(p.paid, 0)) AS balance
  FROM salary_vouchers sv
  JOIN teachers t ON t.id = sv.teacher_id
  LEFT JOIN (SELECT voucher_id, SUM(amount) paid FROM salary_payments GROUP BY voucher_id) p ON p.voucher_id = sv.id`;

function salaryDetail(id) {
  const v = db.prepare(`SELECT * FROM (${SALARY_SQL}) WHERE id = ?`).get(id);
  if (!v) throw notFound('Salary voucher');
  v.payments = db.prepare('SELECT * FROM salary_payments WHERE voucher_id = ? ORDER BY id').all(id);
  return v;
}
router.get('/payroll', allow(), (req, res) => {
  const { month, status, q } = req.query;
  const where = [];
  const args = [];
  if (month) { where.push('month = ?'); args.push(month); }
  if (status === 'paid') where.push('balance <= 0');
  if (status === 'unpaid') where.push('balance > 0');
  if (str(q)) { where.push('(teacher_name LIKE ? OR emp_no LIKE ?)'); args.push(`%${str(q)}%`, `%${str(q)}%`); }
  res.json(db.prepare(`SELECT * FROM (${SALARY_SQL}) ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY teacher_name LIMIT 2000`).all(...args));
});
router.get('/payroll/dues', allow(), (req, res) => {
  res.json(db.prepare(`
    SELECT teacher_id, teacher_name, emp_no, subject, COUNT(*) AS months, SUM(balance) AS due, MIN(month) AS since
    FROM (${SALARY_SQL}) WHERE balance > 0 GROUP BY teacher_id ORDER BY due DESC`).all());
});
router.post('/payroll/generate', allow(), (req, res) => {
  const { month } = req.body || {};
  if (!isMonth(month)) throw bad('Choose a month.');
  const teachers = db.prepare("SELECT id, monthly_salary FROM teachers WHERE status = 'active'").all();
  const ins = db.prepare('INSERT OR IGNORE INTO salary_vouchers (teacher_id, month, amount, deduction) VALUES (?, ?, ?, 0)');
  let created = 0, skipped = 0, noSalary = 0;
  db.transaction(() => {
    for (const t of teachers) {
      if (!t.monthly_salary) { noSalary++; continue; }
      const r = ins.run(t.id, month, t.monthly_salary);
      r.changes ? created++ : skipped++;
    }
  })();
  res.json({ created, skipped, noSalary });
});
router.get('/payroll/:id', allow(), (req, res) => res.json(salaryDetail(req.params.id)));
router.put('/payroll/:id', allow(), (req, res) => {
  const amount = int(req.body.amount, -1);
  const deduction = int(req.body.deduction);
  if (amount < 0) throw bad('Enter a valid amount.');
  if (deduction > amount) throw bad('Deduction cannot be more than the amount.');
  const info = db.prepare('UPDATE salary_vouchers SET amount = ?, deduction = ? WHERE id = ?').run(amount, deduction, req.params.id);
  if (!info.changes) throw notFound('Salary voucher');
  res.json(salaryDetail(req.params.id));
});
router.post('/payroll/:id/pay', allow(), (req, res) => {
  const v = salaryDetail(req.params.id);
  const amount = Math.round(Number(req.body.amount));
  if (!(amount > 0)) throw bad('Enter an amount greater than zero.');
  if (amount > v.balance) throw bad(`Amount is more than the balance of Rs ${v.balance}.`);
  const paidOn = isDate(req.body.paid_on) ? req.body.paid_on : todayISO();
  const method = METHODS.includes(req.body.method) ? req.body.method : 'Cash';
  const info = db.prepare('INSERT INTO salary_payments (voucher_id, amount, paid_on, method, note, paid_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(v.id, amount, paidOn, method, str(req.body.note), req.user.name);
  db.prepare('UPDATE salary_payments SET receipt_no = ? WHERE id = ?').run('S-' + String(info.lastInsertRowid).padStart(5, '0'), info.lastInsertRowid);
  res.status(201).json(salaryDetail(v.id));
});
router.delete('/payroll/payments/:id', allow(), (req, res) => {
  const p = db.prepare('SELECT voucher_id FROM salary_payments WHERE id = ?').get(req.params.id);
  if (!p) throw notFound('Payment');
  db.prepare('DELETE FROM salary_payments WHERE id = ?').run(req.params.id);
  res.json(salaryDetail(p.voucher_id));
});

/* ---------- users (admin) ---------- */
const USER_SQL = `SELECT u.id, u.username, u.full_name, u.role, u.active, u.teacher_id, u.last_login,
    t.name AS teacher_name, t.subject AS teacher_subject,
    (SELECT group_concat(trim(c.name || ' ' || c.section), ', ') FROM classes c WHERE c.teacher_id = u.teacher_id) AS class_names
  FROM users u LEFT JOIN teachers t ON t.id = u.teacher_id`;
const ROLES = ['admin', 'teacher', 'accountant'];
// Only teacher logins can be linked to a teacher record; the link decides which classes they see.
function teacherLink(role, teacherId) {
  if (role !== 'teacher' || !teacherId) return null;
  if (!db.prepare('SELECT 1 FROM teachers WHERE id = ?').get(teacherId)) throw bad('Choose a valid teacher record.');
  return Number(teacherId);
}
const PW_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alike letters (l, 1, o, 0, i)
const randomPassword = (len = 8) => Array.from(crypto.randomBytes(len), (b) => PW_CHARS[b % PW_CHARS.length]).join('');
function usernameFrom(name, fallback) {
  const base = str(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '')
    || str(fallback).toLowerCase().replace(/[^a-z0-9]+/g, '') || 'user';
  let candidate = base;
  for (let n = 2; db.prepare('SELECT 1 FROM users WHERE username = ?').get(candidate); n++) candidate = base + n;
  return candidate;
}

router.get('/users', allow(), (req, res) => {
  res.json(db.prepare(USER_SQL + ' ORDER BY u.role, u.full_name').all());
});
router.post('/users', allow(), (req, res) => {
  need(req.body, ['username', 'full_name', 'role', 'password']);
  if (!ROLES.includes(req.body.role)) throw bad('Choose a valid role.');
  if (str(req.body.password).length < 6) throw bad('Password must be at least 6 characters.');
  const link = teacherLink(req.body.role, req.body.teacher_id);
  const info = db.prepare('INSERT INTO users (username, password_hash, full_name, role, teacher_id) VALUES (?, ?, ?, ?, ?)')
    .run(str(req.body.username).toLowerCase(), bcrypt.hashSync(str(req.body.password), 10), str(req.body.full_name), req.body.role, link);
  res.status(201).json(db.prepare(USER_SQL + ' WHERE u.id = ?').get(info.lastInsertRowid));
});
// New teacher + login (+ class) in one step, all or nothing.
router.post('/users/teacher', allow(), (req, res) => {
  need(req.body, ['full_name', 'username', 'password']);
  if (str(req.body.password).length < 6) throw bad('Password must be at least 6 characters.');
  const b = req.body;
  const id = db.transaction(() => {
    const t = db.prepare(`INSERT INTO teachers (emp_no, name, phone, email, qualification, subject, joined_on, monthly_salary, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`).run(nextEmpNo(), str(b.full_name), str(b.phone), str(b.email), str(b.qualification), str(b.subject), todayISO(), int(b.monthly_salary));
    const u = db.prepare("INSERT INTO users (username, password_hash, full_name, role, teacher_id) VALUES (?, ?, ?, 'teacher', ?)")
      .run(str(b.username).toLowerCase(), bcrypt.hashSync(str(b.password), 10), str(b.full_name), t.lastInsertRowid);
    if (b.class_id) {
      const c = db.prepare('UPDATE classes SET teacher_id = ? WHERE id = ?').run(t.lastInsertRowid, b.class_id);
      if (!c.changes) throw bad('Choose a valid class.');
    }
    return u.lastInsertRowid;
  })();
  res.status(201).json(db.prepare(USER_SQL + ' WHERE u.id = ?').get(id));
});
// Logins for every active teacher who does not have one yet. Passwords are only returned here, once.
router.post('/users/teacher-logins', allow(), (req, res) => {
  const teachers = db.prepare(`SELECT t.id, t.emp_no, t.name FROM teachers t
    WHERE t.status = 'active' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.teacher_id = t.id) ORDER BY t.name`).all();
  const ins = db.prepare("INSERT INTO users (username, password_hash, full_name, role, teacher_id) VALUES (?, ?, ?, 'teacher', ?)");
  const created = [];
  db.transaction(() => {
    for (const t of teachers) {
      const username = usernameFrom(t.name, t.emp_no);
      const password = randomPassword();
      ins.run(username, bcrypt.hashSync(password, 10), t.name, t.id);
      created.push({ teacher_id: t.id, name: t.name, emp_no: t.emp_no, username, password });
    }
  })();
  res.json({ created });
});
router.put('/users/:id', allow(), (req, res) => {
  need(req.body, ['full_name', 'role']);
  if (!ROLES.includes(req.body.role)) throw bad('Choose a valid role.');
  const active = req.body.active ? 1 : 0;
  if (Number(req.params.id) === req.user.id && (!active || req.body.role !== 'admin')) {
    throw bad("You can't deactivate or demote your own account.");
  }
  const link = teacherLink(req.body.role, req.body.teacher_id);
  const info = db.prepare('UPDATE users SET full_name = ?, role = ?, active = ?, teacher_id = ? WHERE id = ?')
    .run(str(req.body.full_name), req.body.role, active, link, req.params.id);
  if (!info.changes) throw notFound('User');
  if (str(req.body.password)) {
    if (str(req.body.password).length < 6) throw bad('Password must be at least 6 characters.');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(str(req.body.password), 10), req.params.id);
  }
  res.json(db.prepare(USER_SQL + ' WHERE u.id = ?').get(req.params.id));
});
router.delete('/users/:id', allow(), (req, res) => {
  if (Number(req.params.id) === req.user.id) throw bad("You can't delete your own account.");
  const info = db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  if (!info.changes) throw notFound('User');
  res.json({ ok: true });
});

/* ---------- backup (admin) ---------- */
router.get('/backup', allow(), async (req, res, next) => {
  const file = path.join(os.tmpdir(), `school-backup-${Date.now()}.db`);
  try {
    await db.backup(file);
    res.download(file, `school-backup-${todayISO()}.db`, () => fs.unlink(file, () => {}));
  } catch (err) { next(err); }
});

/* ---------- error handling ---------- */
router.use((req, res) => res.status(404).json({ error: 'Not found.' }));
router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  const code = err && err.code;
  if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
    const m = String(err.message);
    let msg = 'That record already exists.';
    if (m.includes('students.admission_no')) msg = 'That admission number is already in use.';
    else if (m.includes('teachers.emp_no')) msg = 'That employee number is already in use.';
    else if (m.includes('users.username')) msg = 'That username is already taken.';
    else if (m.includes('classes.name')) msg = 'That class and section already exist.';
    else if (m.includes('subjects.class_id')) msg = 'That subject is already added to this class.';
    return res.status(409).json({ error: msg });
  }
  if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return res.status(409).json({ error: 'This record is linked to other data and cannot be removed.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

module.exports = router;
