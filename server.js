const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const Database = require('better-sqlite3');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET === 'buranı-mütləq-dəyiş') {
  console.error('JWT_SECRET .env faylında təyin edilməyib');
  process.exit(1);
}

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json({ limit: '1mb' }));

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ================= VERİLƏNLƏR BAZASI ================= */
const db = new Database(path.join(DATA_DIR, 'yanasi.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS couples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  handle TEXT,
  city TEXT DEFAULT 'Bakı',
  since_label TEXT,
  bio TEXT DEFAULT '',
  started_at TEXT,
  is_pro INTEGER DEFAULT 0,
  cycle_pro INTEGER DEFAULT 0,
  unlocked_astro TEXT DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT UNIQUE,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  zodiac TEXT DEFAULT 'gemini',
  avatar TEXT,
  pair_code TEXT UNIQUE,
  pair_code_created_at TEXT,
  couple_id INTEGER REFERENCES couples(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  couple_id INTEGER NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feelings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  couple_id INTEGER NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  couple_id INTEGER NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_url TEXT NOT NULL,
  media_type TEXT DEFAULT 'image',
  caption TEXT DEFAULT '',
  location TEXT DEFAULT '',
  category TEXT DEFAULT 'ideas',
  hashtags TEXT DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS post_likes (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  couple_id INTEGER NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  location TEXT DEFAULT '',
  date_label TEXT DEFAULT '',
  album TEXT DEFAULT 'dates',
  mood TEXT DEFAULT '',
  story TEXT DEFAULT '',
  favorite INTEGER DEFAULT 0,
  img TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  couple_id INTEGER NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT DEFAULT '19:00',
  type TEXT DEFAULT 'date',
  remind TEXT DEFAULT 'none',
  done INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dreams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  couple_id INTEGER NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  note TEXT DEFAULT '',
  done INTEGER DEFAULT 0,
  photo TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cycle_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  duration INTEGER DEFAULT 5,
  flow TEXT DEFAULT 'Orta',
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  couple_id INTEGER NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_num INTEGER NOT NULL,
  answer TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (couple_id, user_id, question_num)
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  desc TEXT DEFAULT '',
  unread INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_couple ON messages(couple_id, id);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, id);
`);

/* ================= KÖMƏKÇİLƏR ================= */
const now = () => new Date().toISOString();
const sign = (user) => jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: '30d' });
const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

function publicUser(u) {
  if (!u) return null;
  const { password_hash, ...rest } = u;
  return rest;
}

function partnerOf(user) {
  if (!user.couple_id) return null;
  return db.prepare('SELECT * FROM users WHERE couple_id = ? AND id <> ?').get(user.couple_id, user.id);
}

function mePayload(user) {
  const couple = user.couple_id ? db.prepare('SELECT * FROM couples WHERE id = ?').get(user.couple_id) : null;
  if (couple) couple.unlocked_astro = JSON.parse(couple.unlocked_astro || '[]');
  return { user: publicUser(user), couple, partner: publicUser(partnerOf(user)) };
}

function newPairCode() {
  for (let i = 0; i < 30; i++) {
    const code = String(crypto.randomInt(100000, 1000000));
    if (!db.prepare('SELECT 1 FROM users WHERE pair_code = ?').get(code)) return code;
  }
  throw new Error('Kod yaradıla bilmədi');
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ error: 'Giriş tələb olunur' });
  try {
    const { uid } = jwt.verify(token, JWT_SECRET);
    const user = getUser(uid);
    if (!user) return res.status(401).json({ error: 'İstifadəçi tapılmadı' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Sessiya bitib, yenidən daxil ol' });
  }
}

function needCouple(req, res, next) {
  if (!req.user.couple_id) return res.status(403).json({ error: 'Əvvəlcə sevgilinlə cütləş' });
  next();
}

const hits = new Map();
function limit(max, windowMs) {
  return (req, res, next) => {
    const key = req.ip + req.path;
    const t = Date.now();
    const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
    arr.push(t);
    hits.set(key, arr);
    if (arr.length > max) return res.status(429).json({ error: 'Çox cəhd. Bir az sonra yenidən yoxla' });
    next();
  };
}

function pick(body, fields) {
  const out = {};
  for (const [k, type] of Object.entries(fields)) {
    const v = body?.[k];
    if (v === undefined || v === null) continue;
    if (type === 'bool') out[k] = v ? 1 : 0;
    else if (type === 'int') out[k] = Number(v) || 0;
    else out[k] = String(v).trim().slice(0, 2000);
  }
  return out;
}

const isMediaUrl = (u) => typeof u === 'string' && (u.startsWith('/uploads/') || u.startsWith('https://'));

/* ================= CANLI BİLDİRİŞLƏR (SSE) ================= */
const streams = new Map();

function push(userId, event, data) {
  const set = streams.get(userId);
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  set.forEach((r) => r.write(payload));
}

function notify(userId, type, title, desc = '') {
  const info = db.prepare('INSERT INTO notifications (user_id, type, title, desc, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, type, title, desc, now());
  push(userId, 'notification', { id: info.lastInsertRowid, type, title, desc, unread: 1, created_at: now() });
}

app.get('/api/stream', auth, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  const set = streams.get(req.user.id) || new Set();
  set.add(res);
  streams.set(req.user.id, set);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); set.delete(res); });
});

/* ================= AUTH ================= */
app.post('/api/auth/register', limit(10, 60_000), (req, res) => {
  const { name, username, email, password, zodiac } = req.body || {};
  const em = String(email || '').trim().toLowerCase();
  const un = String(username || '').trim().replace(/^@/, '').toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(em)) return res.status(400).json({ error: 'Düzgün e-poçt yaz' });
  if (!password || String(password).length < 6) return res.status(400).json({ error: 'Şifrə ən azı 6 simvol olmalıdır' });
  if (un && !/^[a-z0-9_.]{3,24}$/.test(un)) return res.status(400).json({ error: 'İstifadəçi adı 3–24 simvol olmalıdır: hərf, rəqəm, _ və .' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(em)) return res.status(409).json({ error: 'Bu e-poçt artıq qeydiyyatdadır' });
  if (un && db.prepare('SELECT 1 FROM users WHERE username = ?').get(un)) return res.status(409).json({ error: 'Bu istifadəçi adı artıq tutulub' });

  const info = db.prepare(`INSERT INTO users (name, username, email, password_hash, zodiac, pair_code, pair_code_created_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    String(name || '').trim().slice(0, 60) || em.split('@')[0],
    un || null, em, bcrypt.hashSync(String(password), 10),
    String(zodiac || 'gemini'), newPairCode(), now(), now()
  );
  const user = getUser(info.lastInsertRowid);
  res.status(201).json({ token: sign(user), ...mePayload(user) });
});

app.post('/api/auth/login', limit(10, 60_000), (req, res) => {
  const id = String(req.body?.identifier || '').trim().toLowerCase().replace(/^@/, '');
  const user = db.prepare('SELECT * FROM users WHERE email = ? OR username = ?').get(id, id);
  if (!user || !bcrypt.compareSync(String(req.body?.password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'E-poçt və ya şifrə yanlışdır' });
  }
  res.json({ token: sign(user), ...mePayload(user) });
});

app.get('/api/me', auth, (req, res) => res.json(mePayload(req.user)));

app.patch('/api/me', auth, (req, res) => {
  const data = pick(req.body, { name: 'text', zodiac: 'text', avatar: 'text' });
  if (data.avatar && !isMediaUrl(data.avatar)) delete data.avatar;
  const cols = Object.keys(data);
  if (cols.length) db.prepare(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => data[c]), req.user.id);
  res.json(mePayload(getUser(req.user.id)));
});

/* ================= CÜTLƏŞMƏ ================= */
app.post('/api/pair/code', auth, (req, res) => {
  const code = newPairCode();
  db.prepare('UPDATE users SET pair_code = ?, pair_code_created_at = ? WHERE id = ?').run(code, now(), req.user.id);
  res.json({ pair_code: code });
});

app.post('/api/pair', auth, limit(10, 60_000), (req, res) => {
  if (req.user.couple_id) return res.status(409).json({ error: 'Artıq cütləşmisən' });
  const code = String(req.body?.code || '').replace(/\D/g, '');
  const partner = db.prepare('SELECT * FROM users WHERE pair_code = ?').get(code);
  if (!partner || partner.id === req.user.id) return res.status(404).json({ error: 'Kod tapılmadı' });
  if (partner.couple_id) return res.status(409).json({ error: 'Bu istifadəçi artıq cütləşib' });
  if (Date.now() - new Date(partner.pair_code_created_at).getTime() > 24 * 3600 * 1000) {
    return res.status(410).json({ error: 'Kodun vaxtı bitib. Sevgilindən yeni kod istə' });
  }

  db.transaction(() => {
    const name = `${req.user.name} & ${partner.name}`;
    const handle = `@${req.user.username || 'u' + req.user.id}_${partner.username || 'u' + partner.id}`;
    const c = db.prepare('INSERT INTO couples (name, handle, started_at, since_label, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, handle, now().slice(0, 10), 'Bu gündən birlikdə', now());
    db.prepare('UPDATE users SET couple_id = ? WHERE id IN (?, ?)').run(c.lastInsertRowid, req.user.id, partner.id);
  })();

  notify(partner.id, 'partner', `${req.user.name} səninlə cütləşdi 💜`, 'Ortaq dünyanız hazırdır');
  push(partner.id, 'paired', {});
  res.json(mePayload(getUser(req.user.id)));
});

app.patch('/api/couple', auth, needCouple, (req, res) => {
  const data = pick(req.body, { name: 'text', handle: 'text', city: 'text', since_label: 'text', bio: 'text' });
  if (data.handle && !data.handle.startsWith('@')) data.handle = '@' + data.handle;
  const cols = Object.keys(data);
  if (cols.length) db.prepare(`UPDATE couples SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => data[c]), req.user.couple_id);
  res.json(mePayload(req.user));
});

/* ================= MESAJLAR & HİSLƏR ================= */
app.get('/api/messages', auth, needCouple, (req, res) => {
  const after = Number(req.query.after || 0);
  res.json(db.prepare('SELECT * FROM messages WHERE couple_id = ? AND id > ? ORDER BY id ASC LIMIT 300').all(req.user.couple_id, after));
});

app.post('/api/messages', auth, needCouple, (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'Mesaj boşdur' });
  const info = db.prepare('INSERT INTO messages (couple_id, sender_id, text, created_at) VALUES (?, ?, ?, ?)').run(req.user.couple_id, req.user.id, text, now());
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
  const p = partnerOf(req.user);
  if (p) push(p.id, 'message', msg);
  res.status(201).json(msg);
});

const FEELINGS = { hug: 'qucaqlama 🤗', kiss: 'öpüş 💋', think: '"Səni düşünürəm" 💭', miss: '"Darıxdım" 🥺', heartbeat: 'ürək atışı 💓' };
app.post('/api/feelings', auth, needCouple, (req, res) => {
  const type = req.body?.type;
  if (!FEELINGS[type]) return res.status(400).json({ error: 'Naməlum hiss' });
  db.prepare('INSERT INTO feelings (couple_id, sender_id, type, created_at) VALUES (?, ?, ?, ?)').run(req.user.couple_id, req.user.id, type, now());
  const p = partnerOf(req.user);
  if (p) {
    push(p.id, 'feeling', { type, from: req.user.name });
    notify(p.id, 'partner', `${req.user.name} sənə ${FEELINGS[type]} göndərdi`, 'Cavab olaraq hiss göndər');
  }
  res.status(201).json({ ok: true });
});

/* ================= AXIN: PAYLAŞIM, BƏYƏNMƏ, ŞƏRH ================= */
app.get('/api/posts', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, c.name AS author, c.handle,
      (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id) AS likes,
      (SELECT COUNT(*) FROM comments m WHERE m.post_id = p.id) AS comments,
      EXISTS (SELECT 1 FROM post_likes l WHERE l.post_id = p.id AND l.user_id = ?) AS liked
    FROM posts p JOIN couples c ON c.id = p.couple_id
    ORDER BY p.id DESC LIMIT 60`).all(req.user.id);
  res.json(rows.map((r) => ({ ...r, hashtags: JSON.parse(r.hashtags || '[]'), liked: !!r.liked })));
});

app.post('/api/posts', auth, needCouple, (req, res) => {
  const b = req.body || {};
  if (!isMediaUrl(b.media_url)) return res.status(400).json({ error: 'Foto və ya video seç' });
  const tags = Array.isArray(b.hashtags) ? b.hashtags.slice(0, 15).map((t) => String(t).slice(0, 40)) : [];
  const info = db.prepare(`INSERT INTO posts (couple_id, author_id, media_url, media_type, caption, location, category, hashtags, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.user.couple_id, req.user.id, b.media_url, b.media_type === 'video' ? 'video' : 'image',
    String(b.caption || '').slice(0, 2000), String(b.location || '').slice(0, 120),
    String(b.category || 'ideas').slice(0, 30), JSON.stringify(tags), now()
  );
  res.status(201).json(db.prepare('SELECT * FROM posts WHERE id = ?').get(info.lastInsertRowid));
});

app.post('/api/posts/:id/like', auth, (req, res) => {
  const id = Number(req.params.id);
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  if (!post) return res.status(404).json({ error: 'Paylaşım tapılmadı' });
  const exists = db.prepare('SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?').get(id, req.user.id);
  if (exists) db.prepare('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?').run(id, req.user.id);
  else db.prepare('INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)').run(id, req.user.id);
  const likes = db.prepare('SELECT COUNT(*) AS n FROM post_likes WHERE post_id = ?').get(id).n;
  res.json({ liked: !exists, likes });
});

app.get('/api/posts/:id/comments', auth, (req, res) => {
  res.json(db.prepare(`SELECT m.*, u.name AS author FROM comments m JOIN users u ON u.id = m.user_id
    WHERE m.post_id = ? ORDER BY m.id DESC`).all(Number(req.params.id)));
});

app.post('/api/posts/:id/comments', auth, (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 1000);
  if (!text) return res.status(400).json({ error: 'Şərh boşdur' });
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(req.params.id));
  if (!post) return res.status(404).json({ error: 'Paylaşım tapılmadı' });
  const info = db.prepare('INSERT INTO comments (post_id, user_id, text, created_at) VALUES (?, ?, ?, ?)').run(post.id, req.user.id, text, now());
  db.prepare('SELECT id FROM users WHERE couple_id = ?').all(post.couple_id)
    .filter((u) => u.id !== req.user.id)
    .forEach((u) => notify(u.id, 'followers', `${req.user.name} paylaşımınıza şərh yazdı`, text.slice(0, 80)));
  res.status(201).json({ ...db.prepare('SELECT * FROM comments WHERE id = ?').get(info.lastInsertRowid), author: req.user.name });
});

/* ================= ANILAR, TƏQVİM, ARZULAR (CRUD) ================= */
function crud(route, table, fields, required = 'title', onCreate) {
  app.get(`/api/${route}`, auth, needCouple, (req, res) => {
    res.json(db.prepare(`SELECT * FROM ${table} WHERE couple_id = ? ORDER BY id DESC`).all(req.user.couple_id));
  });
  app.post(`/api/${route}`, auth, needCouple, (req, res) => {
    const data = pick(req.body, fields);
    if (!data[required]) return res.status(400).json({ error: 'Başlıq yaz' });
    const cols = Object.keys(data);
    const info = db.prepare(`INSERT INTO ${table} (couple_id, ${cols.join(', ')}, created_at) VALUES (?, ${cols.map(() => '?').join(', ')}, ?)`)
      .run(req.user.couple_id, ...cols.map((c) => data[c]), now());
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(info.lastInsertRowid);
    if (onCreate) onCreate(req, row);
    res.status(201).json(row);
  });
  app.patch(`/api/${route}/:id`, auth, needCouple, (req, res) => {
    const data = pick(req.body, fields);
    const cols = Object.keys(data);
    if (cols.length) {
      db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND couple_id = ?`)
        .run(...cols.map((c) => data[c]), Number(req.params.id), req.user.couple_id);
    }
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND couple_id = ?`).get(Number(req.params.id), req.user.couple_id);
    if (!row) return res.status(404).json({ error: 'Tapılmadı' });
    res.json(row);
  });
  app.delete(`/api/${route}/:id`, auth, needCouple, (req, res) => {
    db.prepare(`DELETE FROM ${table} WHERE id = ? AND couple_id = ?`).run(Number(req.params.id), req.user.couple_id);
    res.json({ ok: true });
  });
}

crud('memories', 'memories', { title: 'text', location: 'text', date_label: 'text', album: 'text', mood: 'text', story: 'text', favorite: 'bool', img: 'text' });
crud('events', 'events', { title: 'text', date: 'text', time: 'text', type: 'text', remind: 'text', done: 'bool' }, 'title', (req, row) => {
  if (!req.body?.notify_partner) return;
  const p = partnerOf(req.user);
  if (p) notify(p.id, 'partner', `${req.user.name} təqvimə əlavə etdi: ${row.title}`, `${row.date} • ${row.time}`);
});
crud('dreams', 'dreams', { title: 'text', note: 'text', done: 'bool', photo: 'text' });

/* ================= DÖVR TƏQVİMİ ================= */
app.get('/api/cycle', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM cycle_logs WHERE user_id = ? ORDER BY start_date DESC').all(req.user.id));
});

app.post('/api/cycle', auth, (req, res) => {
  const b = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.start_date || ''))) return res.status(400).json({ error: 'Tarixi seç' });
  const duration = Math.min(10, Math.max(1, Number(b.duration) || 5));
  const flow = ['Yüngül', 'Orta', 'Güclü'].includes(b.flow) ? b.flow : 'Orta';
  const info = db.prepare('INSERT INTO cycle_logs (user_id, start_date, duration, flow, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.id, b.start_date, duration, flow, String(b.note || '').slice(0, 300), now());
  if (b.notify_partner) {
    const p = partnerOf(req.user);
    if (p) notify(p.id, 'partner', `${req.user.name} üçün qayğı xatırlatması 🌸`, 'Bu günlərdə bir az əlavə diqqət çox xoş olar');
  }
  res.status(201).json(db.prepare('SELECT * FROM cycle_logs WHERE id = ?').get(info.lastInsertRowid));
});

/* ================= GÜNÜN SUALI ================= */
function dailyState(req, num) {
  const rows = db.prepare('SELECT user_id, answer FROM daily_answers WHERE couple_id = ? AND question_num = ?').all(req.user.couple_id, num);
  const mine = rows.find((r) => r.user_id === req.user.id);
  const theirs = rows.find((r) => r.user_id !== req.user.id);
  return { mine: mine?.answer || null, partnerAnswered: !!theirs, partner: mine && theirs ? theirs.answer : null };
}

app.get('/api/daily/:num', auth, needCouple, (req, res) => res.json(dailyState(req, Number(req.params.num))));

app.post('/api/daily/:num', auth, needCouple, (req, res) => {
  const num = Number(req.params.num);
  const answer = String(req.body?.answer || '').trim().slice(0, 1000);
  if (!answer) return res.status(400).json({ error: 'Cavabını yaz' });
  db.prepare(`INSERT INTO daily_answers (couple_id, user_id, question_num, answer, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (couple_id, user_id, question_num) DO UPDATE SET answer = excluded.answer`)
    .run(req.user.couple_id, req.user.id, num, answer, now());
  const p = partnerOf(req.user);
  if (p) push(p.id, 'daily', { num });
  res.json(dailyState(req, num));
});

/* ================= BİLDİRİŞLƏR ================= */
app.get('/api/notifications', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id));
});

app.post('/api/notifications/read-all', auth, (req, res) => {
  db.prepare('UPDATE notifications SET unread = 0 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

/* ================= FAYL YÜKLƏMƏ ================= */
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^(image|video)\//.test(file.mimetype)),
});

app.post('/api/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Yalnız foto və ya video yükləmək olar' });
  res.status(201).json({ url: `/uploads/${req.file.filename}`, type: req.file.mimetype.startsWith('video/') ? 'video' : 'image' });
});

/* ================= ÖDƏNİŞLƏR (ASTRO & SAĞLAMLIQ) ================= */
app.post('/api/purchases', auth, needCouple, (req, res) => {
  if (process.env.ALLOW_FAKE_PURCHASES !== 'true') {
    return res.status(501).json({ error: 'Ödəniş sistemi hələ qoşulmayıb' });
  }
  const { product, sectionId } = req.body || {};
  const couple = db.prepare('SELECT * FROM couples WHERE id = ?').get(req.user.couple_id);
  if (product === 'astro_single') {
    const list = JSON.parse(couple.unlocked_astro || '[]');
    if (sectionId && !list.includes(sectionId)) list.push(String(sectionId));
    db.prepare('UPDATE couples SET unlocked_astro = ? WHERE id = ?').run(JSON.stringify(list), couple.id);
  } else if (product === 'astro_bundle') {
    db.prepare('UPDATE couples SET is_pro = 1 WHERE id = ?').run(couple.id);
  } else if (product === 'cycle') {
    db.prepare('UPDATE couples SET cycle_pro = 1 WHERE id = ?').run(couple.id);
  } else if (product === 'vip') {
    db.prepare('UPDATE couples SET is_pro = 1, cycle_pro = 1 WHERE id = ?').run(couple.id);
  } else {
    return res.status(400).json({ error: 'Naməlum paket' });
  }
  res.json(mePayload(req.user));
});

/* ================= STATİK FAYLLAR ================= */
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((req, res) => res.status(404).json({ error: 'Tapılmadı' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server xətası' });
});

app.listen(PORT, () => console.log(`Yanaşı işləyir: http://localhost:${PORT}`));
