'use strict';
// Adds sample teachers, classes, students, attendance, an exam and fee vouchers.
// Usage: npm run seed:demo      (only runs when there are no students yet)
const { db } = require('./db');

if (db.prepare('SELECT COUNT(*) c FROM students').get().c > 0) {
  console.log('Students already exist - demo data skipped.');
  process.exit(0);
}

const teachers = [
  ['Ayesha Khan', 'English', '0300-1111111'],
  ['Imran Ali', 'Mathematics', '0300-2222222'],
  ['Sana Gul', 'Science', '0300-3333333'],
  ['Bilal Ahmad', 'Urdu', '0300-4444444'],
];
const insT = db.prepare('INSERT INTO teachers (emp_no, name, subject, phone, joined_on) VALUES (?, ?, ?, ?, ?)');
const tIds = teachers.map((t, i) => insT.run('T-' + String(i + 1).padStart(3, '0'), t[0], t[1], t[2], '2022-04-01').lastInsertRowid);

const classes = [
  ['Class 5', 'A', tIds[0], 1500],
  ['Class 6', 'A', tIds[1], 1800],
  ['Class 7', 'A', tIds[2], 2000],
];
const insC = db.prepare('INSERT INTO classes (name, section, teacher_id, monthly_fee) VALUES (?, ?, ?, ?)');
const cIds = classes.map((c) => insC.run(...c).lastInsertRowid);

const subjectNames = ['English', 'Urdu', 'Mathematics', 'Science', 'Islamiat'];
const insS = db.prepare('INSERT INTO subjects (class_id, name, total_marks) VALUES (?, ?, 100)');
for (const cid of cIds) for (const n of subjectNames) insS.run(cid, n);

const boys = ['Ahmed', 'Hamza', 'Usman', 'Zain', 'Hassan', 'Ali', 'Omar', 'Faisal'];
const girls = ['Fatima', 'Maryam', 'Hina', 'Zoya', 'Iqra', 'Noor', 'Amna', 'Sadia'];
const fathers = ['Khalid Khan', 'Rashid Ali', 'Tariq Mehmood', 'Nasir Shah', 'Javed Iqbal', 'Waqar Ahmad'];
const insStu = db.prepare(`INSERT INTO students (admission_no, name, father_name, gender, phone, class_id, admitted_on)
  VALUES (?, ?, ?, ?, ?, ?, ?)`);
let n = 1;
const studentIds = [];
for (const cid of cIds) {
  for (let i = 0; i < 8; i++) {
    const girl = i % 2 === 1;
    const name = (girl ? girls : boys)[(i + cid) % 8] + ' ' + fathers[i % fathers.length].split(' ')[1];
    const id = insStu.run(String(n).padStart(4, '0'), name, fathers[i % fathers.length], girl ? 'Female' : 'Male',
      '0311-' + String(1000000 + n * 137).slice(0, 7), cid, '2024-04-01').lastInsertRowid;
    studentIds.push([id, cid]);
    n++;
  }
}

// Attendance for the last 5 weekdays
const insA = db.prepare('INSERT OR IGNORE INTO attendance (student_id, date, status) VALUES (?, ?, ?)');
const days = [];
for (let d = 0; days.length < 5; d++) {
  const dt = new Date(Date.now() - d * 86400000);
  if (dt.getUTCDay() !== 0 && dt.getUTCDay() !== 6) days.push(dt.toISOString().slice(0, 10));
}
for (const [sid] of studentIds) {
  for (const day of days) {
    const r = Math.random();
    insA.run(sid, day, r < 0.85 ? 'P' : r < 0.95 ? 'A' : 'L');
  }
}

// One exam per class with marks
const insE = db.prepare('INSERT INTO exams (name, class_id, term, held_on) VALUES (?, ?, ?, ?)');
const insM = db.prepare('INSERT INTO marks (exam_id, student_id, subject_id, obtained) VALUES (?, ?, ?, ?)');
for (const cid of cIds) {
  const eid = insE.run('Mid-term exam', cid, 'Term 1', '2026-09-01').lastInsertRowid;
  const subs = db.prepare('SELECT id FROM subjects WHERE class_id = ?').all(cid);
  for (const [sid, c] of studentIds) {
    if (c !== cid) continue;
    for (const s of subs) insM.run(eid, sid, s.id, 35 + Math.floor(Math.random() * 62));
  }
}

// Fee vouchers for this month, some already paid
const month = new Date().toISOString().slice(0, 7);
const insV = db.prepare('INSERT INTO fee_vouchers (student_id, month, amount, discount, due_date) VALUES (?, ?, ?, 0, ?)');
const insP = db.prepare("INSERT INTO fee_payments (voucher_id, amount, paid_on, method, received_by, receipt_no) VALUES (?, ?, ?, 'Cash', 'Administrator', ?)");
let rc = 1;
for (const [sid, cid] of studentIds) {
  const fee = db.prepare('SELECT monthly_fee f FROM classes WHERE id = ?').get(cid).f;
  const vid = insV.run(sid, month, fee, month + '-10').lastInsertRowid;
  if (Math.random() < 0.6) insP.run(vid, fee, new Date().toISOString().slice(0, 10), 'R-' + String(rc++).padStart(5, '0'));
}

db.prepare("UPDATE settings SET value = 'Demo Public School' WHERE key = 'school_name' AND value = 'My School'").run();
console.log(`Demo data added: ${teachers.length} teachers, ${classes.length} classes, ${studentIds.length} students.`);
