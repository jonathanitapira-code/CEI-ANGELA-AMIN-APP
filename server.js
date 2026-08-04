/**
 * CEI Angela Amin - App para pais e professores
 * ------------------------------------------------
 * Servidor unico (Express + Socket.IO + SQLite) que fornece:
 *   - Cadastro/login com papeis (professor, pai/responsavel, cozinha, admin)
 *   - Turmas com link de convite, sala de bate-papo em tempo real
 *   - Identificacao de quem e quem (professor, responsavel + nome da crianca)
 *   - Envio de imagens e PDFs no chat, visualizados dentro do app (sem link de download)
 *   - Agenda de cardapio diario (cozinha/professor/admin publicam, todos veem)
 *   - Aba financeira simples (receitas/despesas + saldo)
 *
 * Para rodar:
 *   npm install
 *   npm start
 *   Acesse http://localhost:3000
 *
 * Variaveis de ambiente opcionais:
 *   PORT            - porta do servidor (padrao 3000)
 *   SESSION_SECRET  - segredo da sessao (troque em producao!)
 *   STAFF_CODE      - codigo que a equipe (professor/cozinha/direcao) precisa
 *                     informar para criar uma conta de equipe (padrao: "creche2026")
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const Database = require('better-sqlite3');
const { nanoid } = require('nanoid');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'troque-este-segredo-em-producao';
const STAFF_CODE = process.env.STAFF_CODE || 'creche2026';

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Banco de dados
// ---------------------------------------------------------------------------
const db = new Database(path.join(DATA_DIR, 'creche.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('professor','pai','cozinha','admin')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS turmas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  invite_code TEXT UNIQUE NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS turma_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turma_id INTEGER NOT NULL REFERENCES turmas(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  child_name TEXT,
  joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(turma_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turma_id INTEGER NOT NULL REFERENCES turmas(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  content TEXT,
  attachment_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turma_id INTEGER NOT NULL,
  uploader_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  original_name TEXT,
  mime TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('imagem','pdf')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cardapio (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  meal_type TEXT NOT NULL,
  description TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS financeiro (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('receita','despesa')),
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

// ---------------------------------------------------------------------------
// App / middlewares
// ---------------------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 } // 30 dias
});
app.use(sessionMiddleware);

// Compartilha a sessao com o Socket.IO (socket.io >= 4.6 suporta io.engine.use)
io.engine.use(sessionMiddleware);

const ROLE_LABELS = {
  professor: 'Professor(a)',
  pai: 'Responsavel',
  cozinha: 'Cozinha',
  admin: 'Direcao'
};
const STAFF_ROLES = ['professor', 'cozinha', 'admin'];

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, email: u.email, role: u.role, roleLabel: ROLE_LABELS[u.role] };
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Nao autenticado' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Nao autenticado' });
  req.user = user;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Sem permissao para esta acao' });
    }
    next();
  };
}

function isTurmaMember(turmaId, userId) {
  return db.prepare('SELECT 1 FROM turma_members WHERE turma_id = ? AND user_id = ?').get(turmaId, userId);
}

function requireTurmaMember(req, res, next) {
  const turmaId = Number(req.params.id || req.body.turmaId || req.query.turmaId);
  if (!turmaId || !isTurmaMember(turmaId, req.user.id)) {
    return res.status(403).json({ error: 'Voce nao faz parte desta turma' });
  }
  req.turmaId = turmaId;
  next();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
app.post('/api/register', (req, res) => {
  const { name, email, password, role, staffCode } = req.body;
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'Preencha nome, e-mail, senha e papel' });
  }
  if (!['professor', 'pai', 'cozinha', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Papel invalido' });
  }
  if (STAFF_ROLES.includes(role) && staffCode !== STAFF_CODE) {
    return res.status(403).json({ error: 'Codigo da equipe invalido. Peça o codigo a direcao da creche.' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (existing) return res.status(409).json({ error: 'Ja existe uma conta com este e-mail' });

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(
    'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)'
  ).run(name.trim(), email.toLowerCase().trim(), hash, role);

  req.session.userId = info.lastInsertRowid;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.json({ user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'E-mail ou senha invalidos' });
  }
  req.session.userId = user.id;
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// ---------------------------------------------------------------------------
// Turmas
// ---------------------------------------------------------------------------
app.post('/api/turmas', requireAuth, requireRole('professor', 'admin'), (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Informe o nome da turma' });
  const code = nanoid(8);
  const info = db.prepare(
    'INSERT INTO turmas (name, invite_code, created_by) VALUES (?, ?, ?)'
  ).run(name.trim(), code, req.user.id);
  db.prepare(
    'INSERT INTO turma_members (turma_id, user_id, child_name) VALUES (?, ?, NULL)'
  ).run(info.lastInsertRowid, req.user.id);
  const turma = db.prepare('SELECT * FROM turmas WHERE id = ?').get(info.lastInsertRowid);
  res.json({ turma });
});

app.get('/api/turmas', requireAuth, (req, res) => {
  const turmas = db.prepare(`
    SELECT t.*, (SELECT COUNT(*) FROM turma_members m WHERE m.turma_id = t.id) as member_count
    FROM turmas t
    JOIN turma_members tm ON tm.turma_id = t.id
    WHERE tm.user_id = ?
    ORDER BY t.created_at DESC
  `).all(req.user.id);
  res.json({ turmas });
});

// Preview publico do convite (sem exigir login) - so mostra o nome da turma
app.get('/api/turmas/invite/:code', (req, res) => {
  const turma = db.prepare('SELECT id, name FROM turmas WHERE invite_code = ?').get(req.params.code);
  if (!turma) return res.status(404).json({ error: 'Convite invalido' });
  res.json({ turma });
});

app.post('/api/turmas/join', requireAuth, (req, res) => {
  const { code, childName } = req.body;
  const turma = db.prepare('SELECT * FROM turmas WHERE invite_code = ?').get(code);
  if (!turma) return res.status(404).json({ error: 'Convite invalido' });
  if (req.user.role === 'pai' && (!childName || !childName.trim())) {
    return res.status(400).json({ error: 'Informe o nome da crianca' });
  }
  const already = isTurmaMember(turma.id, req.user.id);
  if (already) return res.json({ turma });
  db.prepare(
    'INSERT INTO turma_members (turma_id, user_id, child_name) VALUES (?, ?, ?)'
  ).run(turma.id, req.user.id, req.user.role === 'pai' ? childName.trim() : null);
  res.json({ turma });
});

app.get('/api/turmas/:id/members', requireAuth, requireTurmaMember, (req, res) => {
  const members = db.prepare(`
    SELECT u.id, u.name, u.role, m.child_name
    FROM turma_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.turma_id = ?
    ORDER BY (u.role != 'pai'), u.name
  `).all(req.turmaId);
  res.json({
    members: members.map(m => ({ ...m, roleLabel: ROLE_LABELS[m.role] }))
  });
});

// ---------------------------------------------------------------------------
// Upload de anexos (imagem / pdf) - somente visualizacao dentro do app
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, crypto.randomBytes(16).toString('hex') + ext);
    }
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const okImage = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimetype);
    const okPdf = file.mimetype === 'application/pdf';
    if (okImage || okPdf) return cb(null, true);
    cb(new Error('Tipo de arquivo nao permitido. Envie imagens ou PDF.'));
  }
});

app.post('/api/turmas/:id/attachments', requireAuth, requireTurmaMember, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  const kind = req.file.mimetype === 'application/pdf' ? 'pdf' : 'imagem';
  const info = db.prepare(`
    INSERT INTO attachments (turma_id, uploader_id, filename, original_name, mime, kind)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.turmaId, req.user.id, req.file.filename, req.file.originalname, req.file.mimetype, kind);
  res.json({ attachmentId: info.lastInsertRowid, kind });
});

// Serve o arquivo somente para membros da turma, sempre "inline" (nunca como download)
app.get('/api/attachments/:id', requireAuth, (req, res) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!att) return res.status(404).end();
  if (!isTurmaMember(att.turma_id, req.user.id)) return res.status(403).end();
  const filePath = path.join(UPLOAD_DIR, att.filename);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.setHeader('Content-Type', att.mime);
  res.setHeader('Content-Disposition', 'inline'); // sem nome de arquivo -> nao sugere "salvar como"
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  fs.createReadStream(filePath).pipe(res);
});

// ---------------------------------------------------------------------------
// Mensagens do chat (REST para historico; Socket.IO para tempo real)
// ---------------------------------------------------------------------------
app.get('/api/turmas/:id/messages', requireAuth, requireTurmaMember, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const beforeId = req.query.before ? Number(req.query.before) : null;

  let rows;
  if (beforeId) {
    rows = db.prepare(`
      SELECT msg.*, u.name as user_name, u.role as user_role,
             a.id as att_id, a.kind as att_kind, a.original_name as att_name
      FROM messages msg
      JOIN users u ON u.id = msg.user_id
      LEFT JOIN attachments a ON a.id = msg.attachment_id
      WHERE msg.turma_id = ? AND msg.id < ?
      ORDER BY msg.id DESC LIMIT ?
    `).all(req.turmaId, beforeId, limit);
  } else {
    rows = db.prepare(`
      SELECT msg.*, u.name as user_name, u.role as user_role,
             a.id as att_id, a.kind as att_kind, a.original_name as att_name
      FROM messages msg
      JOIN users u ON u.id = msg.user_id
      LEFT JOIN attachments a ON a.id = msg.attachment_id
      WHERE msg.turma_id = ?
      ORDER BY msg.id DESC LIMIT ?
    `).all(req.turmaId, limit);
  }
  rows.reverse();
  res.json({
    messages: rows.map(r => ({
      id: r.id,
      content: r.content,
      createdAt: r.created_at,
      user: { id: r.user_id, name: r.user_name, role: r.user_role, roleLabel: ROLE_LABELS[r.user_role] },
      attachment: r.att_id ? { id: r.att_id, kind: r.att_kind, name: r.att_name } : null
    }))
  });
});

app.post('/api/turmas/:id/messages', requireAuth, requireTurmaMember, (req, res) => {
  const { content, attachmentId } = req.body;
  if ((!content || !content.trim()) && !attachmentId) {
    return res.status(400).json({ error: 'Mensagem vazia' });
  }
  if (attachmentId) {
    const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(attachmentId);
    if (!att || att.turma_id !== req.turmaId) {
      return res.status(400).json({ error: 'Anexo invalido para esta turma' });
    }
  }
  const info = db.prepare(
    'INSERT INTO messages (turma_id, user_id, content, attachment_id) VALUES (?, ?, ?, ?)'
  ).run(req.turmaId, req.user.id, content ? content.trim() : null, attachmentId || null);

  const row = db.prepare(`
    SELECT msg.*, u.name as user_name, u.role as user_role,
           a.id as att_id, a.kind as att_kind, a.original_name as att_name
    FROM messages msg
    JOIN users u ON u.id = msg.user_id
    LEFT JOIN attachments a ON a.id = msg.attachment_id
    WHERE msg.id = ?
  `).get(info.lastInsertRowid);

  const payload = {
    id: row.id,
    turmaId: req.turmaId,
    content: row.content,
    createdAt: row.created_at,
    user: { id: row.user_id, name: row.user_name, role: row.user_role, roleLabel: ROLE_LABELS[row.user_role] },
    attachment: row.att_id ? { id: row.att_id, kind: row.att_kind, name: row.att_name } : null
  };

  io.to('turma_' + req.turmaId).emit('new_message', payload);
  res.json({ message: payload });
});

// ---------------------------------------------------------------------------
// Cardapio (agenda da cozinha)
// ---------------------------------------------------------------------------
app.get('/api/cardapio', requireAuth, (req, res) => {
  const { date, start, end } = req.query;
  let rows;
  if (date) {
    rows = db.prepare(`
      SELECT c.*, u.name as author_name FROM cardapio c JOIN users u ON u.id = c.created_by
      WHERE c.date = ? ORDER BY c.id ASC
    `).all(date);
  } else if (start && end) {
    rows = db.prepare(`
      SELECT c.*, u.name as author_name FROM cardapio c JOIN users u ON u.id = c.created_by
      WHERE c.date BETWEEN ? AND ? ORDER BY c.date ASC, c.id ASC
    `).all(start, end);
  } else {
    rows = db.prepare(`
      SELECT c.*, u.name as author_name FROM cardapio c JOIN users u ON u.id = c.created_by
      ORDER BY c.date DESC, c.id ASC LIMIT 100
    `).all();
  }
  res.json({ cardapio: rows });
});

app.post('/api/cardapio', requireAuth, requireRole('cozinha', 'professor', 'admin'), (req, res) => {
  const { date, mealType, description } = req.body;
  if (!date || !mealType || !description || !description.trim()) {
    return res.status(400).json({ error: 'Preencha data, refeicao e descricao' });
  }
  const info = db.prepare(
    'INSERT INTO cardapio (date, meal_type, description, created_by) VALUES (?, ?, ?, ?)'
  ).run(date, mealType, description.trim(), req.user.id);
  const row = db.prepare(`
    SELECT c.*, u.name as author_name FROM cardapio c JOIN users u ON u.id = c.created_by WHERE c.id = ?
  `).get(info.lastInsertRowid);
  res.json({ item: row });
});

app.delete('/api/cardapio/:id', requireAuth, requireRole('cozinha', 'professor', 'admin'), (req, res) => {
  const item = db.prepare('SELECT * FROM cardapio WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Nao encontrado' });
  if (item.created_by !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Somente quem criou ou a direcao pode remover' });
  }
  db.prepare('DELETE FROM cardapio WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Financeiro (prestacao de contas simples)
// ---------------------------------------------------------------------------
app.get('/api/financeiro', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT f.*, u.name as author_name FROM financeiro f JOIN users u ON u.id = f.created_by
    ORDER BY f.date DESC, f.id DESC
  `).all();
  const totals = rows.reduce((acc, r) => {
    if (r.type === 'receita') acc.receitas += r.amount; else acc.despesas += r.amount;
    return acc;
  }, { receitas: 0, despesas: 0 });
  res.json({ lancamentos: rows, totals: { ...totals, saldo: totals.receitas - totals.despesas } });
});

app.post('/api/financeiro', requireAuth, requireRole('admin', 'professor'), (req, res) => {
  const { date, type, description, amount } = req.body;
  if (!date || !['receita', 'despesa'].includes(type) || !description || !amount) {
    return res.status(400).json({ error: 'Preencha data, tipo, descricao e valor' });
  }
  const value = Number(amount);
  if (isNaN(value) || value <= 0) return res.status(400).json({ error: 'Valor invalido' });
  const info = db.prepare(
    'INSERT INTO financeiro (date, type, description, amount, created_by) VALUES (?, ?, ?, ?, ?)'
  ).run(date, type, description.trim(), value, req.user.id);
  const row = db.prepare(`
    SELECT f.*, u.name as author_name FROM financeiro f JOIN users u ON u.id = f.created_by WHERE f.id = ?
  `).get(info.lastInsertRowid);
  res.json({ item: row });
});

app.delete('/api/financeiro/:id', requireAuth, requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM financeiro WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Socket.IO - chat em tempo real
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  const sess = socket.request.session;
  if (!sess || !sess.userId) {
    socket.disconnect(true);
    return;
  }

  socket.on('join_turma', (turmaId) => {
    if (isTurmaMember(Number(turmaId), sess.userId)) {
      socket.join('turma_' + turmaId);
    }
  });

  socket.on('leave_turma', (turmaId) => {
    socket.leave('turma_' + turmaId);
  });
});

// ---------------------------------------------------------------------------
// Arquivos estaticos do front-end (arquivos "soltos" na raiz do projeto)
// ---------------------------------------------------------------------------
const STATIC_FILES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/style.css': 'style.css',
  '/app.js': 'app.js',
  '/logo.svg': 'logo.svg',
  '/manifest.json': 'manifest.json'
};
Object.entries(STATIC_FILES).forEach(([route, file]) => {
  app.get(route, (req, res) => {
    res.sendFile(path.join(__dirname, file));
  });
});

// Tratamento de erros (ex: upload maior que o limite, tipo de arquivo invalido)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'Arquivo muito grande (maximo 15MB)' });
  }
  if (err) {
    console.error(err);
    return res.status(400).json({ error: err.message || 'Erro inesperado' });
  }
  next();
});

server.listen(PORT, () => {
  console.log(`CEI Angela Amin app rodando em http://localhost:${PORT}`);
  console.log(`Codigo de acesso da equipe (STAFF_CODE): ${STAFF_CODE}`);
});
