/**
 * CEI Ângela Amin - App para pais e professores
 * ------------------------------------------------
 * Servidor unico (Express + Socket.IO + SQLite) que fornece:
 *   - Cadastro/login com 9 papeis (responsavel + equipe da creche)
 *   - Turmas com link de convite, sala de bate-papo em tempo real
 *   - Identificacao de quem e quem (papel + nome da crianca, quando for responsavel)
 *   - Mensagens privadas: responsaveis podem falar com a equipe (nunca com outros pais)
 *   - Moderacao: professora regente e direcao podem apagar mensagens de outras pessoas na turma
 *   - Envio de imagens e PDFs no chat (turma e privado), visualizados dentro do app (sem link de download)
 *   - Agenda de cardapio diario (cozinha/equipe pedagogica/direcao publicam, todos veem)
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

// Se DISK_MOUNT_PATH estiver definido (ex: /var/data, apontando para um disco
// persistente do Render), o banco de dados e os arquivos enviados no chat sao
// guardados la dentro e sobrevivem a reinicios/novos deploys. Sem essa variavel
// (ex: rodando no plano gratuito ou no seu computador), tudo fica na propria
// pasta do projeto, como antes.
const DISK_MOUNT_PATH = process.env.DISK_MOUNT_PATH || __dirname;
const DATA_DIR = path.join(DISK_MOUNT_PATH, 'data');
const UPLOAD_DIR = path.join(DISK_MOUNT_PATH, 'uploads');
const AVATAR_DIR = path.join(DISK_MOUNT_PATH, 'avatars');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Banco de dados
// ---------------------------------------------------------------------------
// Nome do arquivo do banco: mudou de "creche.db" para "creche_v2.db" nesta
// atualizacao porque a tabela de usuarios mudou (e-mail virou telefone, entre
// outras colunas novas) - tabelas ja existentes no disco NAO sao alteradas
// automaticamente pelo "CREATE TABLE IF NOT EXISTS". Usar um nome novo garante
// que o banco seja criado do zero, ja com a estrutura certa, sem dar erro.
const db = new Database(path.join(DATA_DIR, 'creche_v2.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN (
    'pai','estagiaria','professora_regente','professora_auxiliar','cozinha',
    'diretora','coordenadora_pedagogica','secretaria','gestor'
  )),
  avatar_filename TEXT,
  active INTEGER NOT NULL DEFAULT 1,
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
  deleted_at TEXT,
  deleted_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Conversas privadas (sempre entre exatamente 2 pessoas; nunca pai-pai)
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_a_id INTEGER NOT NULL REFERENCES users(id),
  user_b_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_a_id, user_b_id)
);

CREATE TABLE IF NOT EXISTS dm_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  content TEXT,
  attachment_id INTEGER,
  deleted_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turma_id INTEGER,
  conversation_id INTEGER,
  uploader_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  original_name TEXT,
  mime TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('imagem','pdf')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  CHECK ((turma_id IS NOT NULL AND conversation_id IS NULL) OR (turma_id IS NULL AND conversation_id IS NOT NULL))
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

// Migracao segura para bancos que ja existiam antes da coluna "active" existir:
// "CREATE TABLE IF NOT EXISTS" nao adiciona colunas novas em uma tabela que ja
// existe no disco, entao aqui verificamos manualmente se a coluna ja existe e,
// se nao existir, adicionamos com ALTER TABLE (isso NAO apaga nenhum dado).
const userColumns = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
if (!userColumns.includes('active')) {
  db.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
}

// ---------------------------------------------------------------------------
// App / middlewares
// ---------------------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('trust proxy', 1); // necessario para cookies funcionarem certo atras do proxy HTTPS do Render
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 dias
    secure: 'auto' // usa cookie seguro automaticamente quando servido via HTTPS (Render), sem quebrar o localhost
  }
});
app.use(sessionMiddleware);

// Compartilha a sessao com o Socket.IO (socket.io >= 4.6 suporta io.engine.use)
io.engine.use(sessionMiddleware);

const ROLE_LABELS = {
  pai: 'Responsável',
  estagiaria: 'Estagiária',
  professora_regente: 'Professora Regente',
  professora_auxiliar: 'Professora Auxiliar',
  cozinha: 'Cozinha',
  diretora: 'Diretora',
  coordenadora_pedagogica: 'Coordenadora Pedagógica',
  secretaria: 'Secretária',
  gestor: 'Gestor'
};
const ALL_ROLES = Object.keys(ROLE_LABELS);
const STAFF_ROLES = ALL_ROLES.filter(r => r !== 'pai');

// O Gestor tem acesso a tudo (superusuario) - so ele cria turma. As demais
// permissoes abaixo continuam valendo para os outros cargos como ja estava.
const TURMA_CREATE_ROLES = ['gestor'];
// Quem pode publicar no cardapio
const CARDAPIO_ROLES = ['cozinha', 'professora_regente', 'professora_auxiliar', 'estagiaria', 'diretora', 'coordenadora_pedagogica', 'gestor'];
// Quem pode remover itens do cardapio criados por outra pessoa
const CARDAPIO_ADMIN_ROLES = ['diretora', 'coordenadora_pedagogica', 'gestor'];
// Quem pode lancar receitas/despesas
const FIN_MANAGE_ROLES = ['diretora', 'gestor', 'secretaria'];
// Quem pode excluir lancamentos financeiros
const FIN_DELETE_ROLES = ['diretora', 'gestor'];
// Direcao da creche - alcancavel em mensagem privada por qualquer responsavel
const DIRECAO_ROLES = ['diretora', 'coordenadora_pedagogica', 'secretaria', 'gestor'];
// Quem pode apagar mensagem de outra pessoa dentro do chat da turma
const MODERACAO_TURMA_ROLES = ['professora_regente', ...DIRECAO_ROLES];

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    phone: u.phone,
    role: u.role,
    roleLabel: ROLE_LABELS[u.role],
    avatarUrl: u.avatar_filename ? `/api/avatar/${u.id}` : null
  };
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Nao autenticado' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user || !user.active) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Nao autenticado' });
  }
  req.user = user;
  next();
}

// O Gestor sempre passa em qualquer checagem de papel (acesso total).
function requireRole(...roles) {
  return (req, res, next) => {
    if (req.user.role === 'gestor' || roles.includes(req.user.role)) return next();
    return res.status(403).json({ error: 'Sem permissao para esta acao' });
  };
}

function isTurmaMember(turmaId, userId) {
  return db.prepare('SELECT 1 FROM turma_members WHERE turma_id = ? AND user_id = ?').get(turmaId, userId);
}

// O Gestor pode acessar qualquer turma mesmo sem ser membro dela (acesso total).
function canAccessTurma(turmaId, user) {
  return user.role === 'gestor' || !!isTurmaMember(turmaId, user.id);
}

function requireTurmaMember(req, res, next) {
  const turmaId = Number(req.params.id || req.body.turmaId || req.query.turmaId);
  if (!turmaId || !canAccessTurma(turmaId, req.user)) {
    return res.status(403).json({ error: 'Voce nao faz parte desta turma' });
  }
  req.turmaId = turmaId;
  next();
}

// Quem pode adicionar/remover membros de uma turma: Gestor (qualquer turma),
// Coordenadora Pedagogica (qualquer turma) ou a Professora Regente daquela turma especifica
function canManageTurmaMembers(turmaId, user) {
  if (user.role === 'gestor' || user.role === 'coordenadora_pedagogica') return true;
  return user.role === 'professora_regente' && !!isTurmaMember(turmaId, user.id);
}

// Duas pessoas "compartilham turma" se aparecem juntas em pelo menos uma turma_members
function sharesTurma(userIdA, userIdB) {
  return db.prepare(`
    SELECT 1 FROM turma_members m1
    JOIN turma_members m2 ON m1.turma_id = m2.turma_id
    WHERE m1.user_id = ? AND m2.user_id = ? LIMIT 1
  `).get(userIdA, userIdB);
}

// Regra de quem pode iniciar uma conversa privada com quem:
//  - nunca entre dois responsaveis (pai/mae)
//  - equipe <-> equipe: sempre pode
//  - responsavel <-> direcao (diretora/coordenadora/secretaria/gestor): sempre pode (alcance da creche toda)
//  - responsavel <-> professora/estagiaria: só se compartilham uma turma (é professora do filho dela)
function canStartConversation(userA, userB) {
  if (userA.id === userB.id) return false;
  if (userA.role === 'pai' && userB.role === 'pai') return false;
  if (userA.role !== 'pai' && userB.role !== 'pai') return true;
  const staffUser = userA.role === 'pai' ? userB : userA;
  if (DIRECAO_ROLES.includes(staffUser.role)) return true;
  return !!sharesTurma(userA.id, userB.id);
}

function isConversationParticipant(conversationId, userId) {
  return db.prepare(
    'SELECT 1 FROM conversations WHERE id = ? AND (user_a_id = ? OR user_b_id = ?)'
  ).get(conversationId, userId, userId);
}

function requireConversationParticipant(req, res, next) {
  const conversationId = Number(req.params.id || req.body.conversationId || req.query.conversationId);
  if (!conversationId || !isConversationParticipant(conversationId, req.user.id)) {
    return res.status(403).json({ error: 'Voce nao faz parte desta conversa' });
  }
  req.conversationId = conversationId;
  next();
}

// ---------------------------------------------------------------------------
// Auth (login por numero de telefone + senha)
// ---------------------------------------------------------------------------

// Normaliza um telefone para so digitos (aceita o usuario digitar com
// parenteses, espacos, tracos, +55 etc; guardamos so os numeros)
function normalizePhone(raw) {
  return (raw || '').replace(/\D/g, '');
}

app.post('/api/register', (req, res) => {
  const { name, password, role, staffCode } = req.body;
  const phone = normalizePhone(req.body.phone);
  if (!name || !phone || !password || !role) {
    return res.status(400).json({ error: 'Preencha nome, telefone, senha e papel' });
  }
  if (phone.length < 10 || phone.length > 13) {
    return res.status(400).json({ error: 'Numero de telefone invalido (informe DDD + numero)' });
  }
  if (!ALL_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Papel invalido' });
  }
  if (STAFF_ROLES.includes(role) && staffCode !== STAFF_CODE) {
    return res.status(403).json({ error: 'Codigo da equipe invalido. Peça o codigo a direcao da creche.' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
  if (existing) return res.status(409).json({ error: 'Ja existe uma conta com este numero de telefone' });

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(
    'INSERT INTO users (name, phone, password_hash, role) VALUES (?, ?, ?, ?)'
  ).run(name.trim(), phone, hash, role);

  req.session.userId = info.lastInsertRowid;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.json({ user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const { password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Telefone ou senha invalidos' });
  }
  if (!user.active) {
    return res.status(403).json({ error: 'Esta conta foi removida. Fale com a direcao da creche.' });
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
// "Esqueci minha senha": como nao ha e-mail nem SMS cadastrados, a
// redefinicao e feita por alguem da direcao (ou o Gestor) direto no app,
// em vez de um link automatico por e-mail/SMS.
// ---------------------------------------------------------------------------

// Lista os usuarios cadastrados e ativos (nome/telefone/papel), para a tela
// "Usuarios" de quem pode redefinir senha, corrigir o papel ou excluir.
app.get('/api/admin/users', requireAuth, requireRole(...DIRECAO_ROLES), (req, res) => {
  const users = db.prepare('SELECT id, name, phone, role FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE').all();
  res.json({ users: users.map(u => ({ ...u, roleLabel: ROLE_LABELS[u.role] })) });
});

// Define uma nova senha para outro usuario. A pessoa deve avisar essa senha
// temporaria diretamente para o dono da conta (por telefone/whatsapp/pessoalmente).
app.post('/api/admin/users/:id/reset-password', requireAuth, requireRole(...DIRECAO_ROLES), (req, res) => {
  const targetId = Number(req.params.id);
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'A nova senha precisa ter pelo menos 6 caracteres' });
  }
  const target = db.prepare('SELECT id FROM users WHERE id = ? AND active = 1').get(targetId);
  if (!target) return res.status(404).json({ error: 'Usuario nao encontrado' });

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, targetId);
  res.json({ ok: true });
});

// Corrige o papel de alguem que se cadastrou errado (ex: marcou "Responsavel"
// mas na verdade e professora). Nao exige o codigo da equipe, ja que quem esta
// fazendo a alteracao ja e da direcao/gestor.
app.put('/api/admin/users/:id/role', requireAuth, requireRole(...DIRECAO_ROLES), (req, res) => {
  const targetId = Number(req.params.id);
  const { role } = req.body;
  if (!ALL_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Papel invalido' });
  }
  const target = db.prepare('SELECT id FROM users WHERE id = ? AND active = 1').get(targetId);
  if (!target) return res.status(404).json({ error: 'Usuario nao encontrado' });

  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, targetId);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  res.json({ user: publicUser(updated) });
});

// Exclui um usuario. Como o historico de mensagens/cardapio/financeiro dessa
// pessoa nao pode sumir (outras pessoas dependem desse historico continuar
// aparecendo certinho no chat/relatorios), a conta e "desativada" em vez de
// apagada de verdade: ela sai de todas as turmas, nao consegue mais entrar no
// app, e o telefone dela fica livre para um novo cadastro (util quando alguem
// se cadastrou duplicado ou saiu da creche).
app.delete('/api/admin/users/:id', requireAuth, requireRole(...DIRECAO_ROLES), (req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'Voce nao pode excluir a sua propria conta' });
  }
  const target = db.prepare('SELECT id FROM users WHERE id = ? AND active = 1').get(targetId);
  if (!target) return res.status(404).json({ error: 'Usuario nao encontrado' });

  const freedPhone = `removido_${targetId}_${Date.now()}`;
  db.prepare('UPDATE users SET active = 0, phone = ? WHERE id = ?').run(freedPhone, targetId);
  db.prepare('DELETE FROM turma_members WHERE user_id = ?').run(targetId);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Foto de perfil
// ---------------------------------------------------------------------------
const uploadAvatar = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, AVATAR_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `u${req.user.id}-` + crypto.randomBytes(8).toString('hex') + ext);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const okImage = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    if (okImage) return cb(null, true);
    cb(new Error('Envie uma imagem (jpg, png ou webp) para a foto de perfil.'));
  }
});

app.post('/api/me/avatar', requireAuth, uploadAvatar.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhuma imagem enviada' });
  const old = req.user.avatar_filename;
  db.prepare('UPDATE users SET avatar_filename = ? WHERE id = ?').run(req.file.filename, req.user.id);
  if (old) {
    const oldPath = path.join(AVATAR_DIR, old);
    fs.unlink(oldPath, () => {});
  }
  res.json({ avatarUrl: `/api/avatar/${req.user.id}` });
});

app.get('/api/avatar/:userId', requireAuth, (req, res) => {
  const u = db.prepare('SELECT avatar_filename FROM users WHERE id = ?').get(req.params.userId);
  if (!u || !u.avatar_filename) return res.status(404).end();
  const filePath = path.join(AVATAR_DIR, u.avatar_filename);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=300');
  fs.createReadStream(filePath).pipe(res);
});

// ---------------------------------------------------------------------------
// Turmas
// ---------------------------------------------------------------------------
app.post('/api/turmas', requireAuth, requireRole(...TURMA_CREATE_ROLES), (req, res) => {
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
  // Gestor enxerga todas as turmas da creche (acesso total), mesmo sem ter entrado nelas
  const turmas = req.user.role === 'gestor'
    ? db.prepare(`
        SELECT t.*, (SELECT COUNT(*) FROM turma_members m WHERE m.turma_id = t.id) as member_count
        FROM turmas t
        ORDER BY t.created_at DESC
      `).all()
    : db.prepare(`
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
    SELECT u.id, u.name, u.role, u.avatar_filename, m.child_name
    FROM turma_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.turma_id = ?
    ORDER BY (u.role != 'pai'), u.name
  `).all(req.turmaId);
  res.json({
    canManage: canManageTurmaMembers(req.turmaId, req.user),
    members: members.map(m => ({
      id: m.id, name: m.name, role: m.role, child_name: m.child_name,
      roleLabel: ROLE_LABELS[m.role],
      avatarUrl: m.avatar_filename ? `/api/avatar/${m.id}` : null
    }))
  });
});

// Lista pessoas que ainda nao estao na turma, para adicionar diretamente (sem link)
app.get('/api/turmas/:id/addable-users', requireAuth, requireTurmaMember, (req, res) => {
  if (!canManageTurmaMembers(req.turmaId, req.user)) {
    return res.status(403).json({ error: 'Sem permissao para gerenciar membros desta turma' });
  }
  const users = db.prepare(`
    SELECT u.id, u.name, u.role FROM users u
    WHERE u.active = 1 AND u.id NOT IN (SELECT user_id FROM turma_members WHERE turma_id = ?)
    ORDER BY (u.role != 'pai'), u.name
  `).all(req.turmaId);
  res.json({ users: users.map(u => ({ ...u, roleLabel: ROLE_LABELS[u.role] })) });
});

app.post('/api/turmas/:id/members', requireAuth, requireTurmaMember, (req, res) => {
  if (!canManageTurmaMembers(req.turmaId, req.user)) {
    return res.status(403).json({ error: 'Sem permissao para gerenciar membros desta turma' });
  }
  const targetUser = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(req.body.userId);
  if (!targetUser) return res.status(404).json({ error: 'Pessoa nao encontrada' });
  if (targetUser.role === 'pai' && (!req.body.childName || !req.body.childName.trim())) {
    return res.status(400).json({ error: 'Informe o nome da crianca' });
  }
  if (isTurmaMember(req.turmaId, targetUser.id)) {
    return res.status(409).json({ error: 'Essa pessoa ja esta na turma' });
  }
  db.prepare('INSERT INTO turma_members (turma_id, user_id, child_name) VALUES (?, ?, ?)')
    .run(req.turmaId, targetUser.id, targetUser.role === 'pai' ? req.body.childName.trim() : null);
  res.json({ ok: true });
});

app.delete('/api/turmas/:id/members/:userId', requireAuth, requireTurmaMember, (req, res) => {
  if (!canManageTurmaMembers(req.turmaId, req.user)) {
    return res.status(403).json({ error: 'Sem permissao para gerenciar membros desta turma' });
  }
  db.prepare('DELETE FROM turma_members WHERE turma_id = ? AND user_id = ?')
    .run(req.turmaId, req.params.userId);
  res.json({ ok: true });
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

// Serve o arquivo somente para quem participa da turma/conversa, sempre "inline" (nunca como download)
app.get('/api/attachments/:id', requireAuth, (req, res) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!att) return res.status(404).end();
  const allowed = att.turma_id
    ? isTurmaMember(att.turma_id, req.user.id)
    : isConversationParticipant(att.conversation_id, req.user.id);
  if (!allowed) return res.status(403).end();
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

  const baseSelect = `
    SELECT msg.*, u.name as user_name, u.role as user_role, u.avatar_filename as user_avatar,
           a.id as att_id, a.kind as att_kind, a.original_name as att_name,
           du.name as deleted_by_name
    FROM messages msg
    JOIN users u ON u.id = msg.user_id
    LEFT JOIN attachments a ON a.id = msg.attachment_id
    LEFT JOIN users du ON du.id = msg.deleted_by
  `;
  let rows;
  if (beforeId) {
    rows = db.prepare(`${baseSelect} WHERE msg.turma_id = ? AND msg.id < ? ORDER BY msg.id DESC LIMIT ?`)
      .all(req.turmaId, beforeId, limit);
  } else {
    rows = db.prepare(`${baseSelect} WHERE msg.turma_id = ? ORDER BY msg.id DESC LIMIT ?`)
      .all(req.turmaId, limit);
  }
  rows.reverse();
  res.json({
    messages: rows.map(r => ({
      id: r.id,
      content: r.deleted_at ? null : r.content,
      createdAt: r.created_at,
      user: {
        id: r.user_id, name: r.user_name, role: r.user_role, roleLabel: ROLE_LABELS[r.user_role],
        avatarUrl: r.user_avatar ? `/api/avatar/${r.user_id}` : null
      },
      attachment: (!r.deleted_at && r.att_id) ? { id: r.att_id, kind: r.att_kind, name: r.att_name } : null,
      deleted: !!r.deleted_at,
      deletedByName: r.deleted_by_name || null,
      canDelete: !r.deleted_at && (r.user_id === req.user.id || MODERACAO_TURMA_ROLES.includes(req.user.role))
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
    SELECT msg.*, u.name as user_name, u.role as user_role, u.avatar_filename as user_avatar,
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
    user: {
      id: row.user_id, name: row.user_name, role: row.user_role, roleLabel: ROLE_LABELS[row.user_role],
      avatarUrl: row.user_avatar ? `/api/avatar/${row.user_id}` : null
    },
    attachment: row.att_id ? { id: row.att_id, kind: row.att_kind, name: row.att_name } : null,
    deleted: false,
    deletedByName: null,
    canDelete: true
  };

  io.to('turma_' + req.turmaId).emit('new_message', payload);
  res.json({ message: payload });
});

// Apaga (soft delete) uma mensagem da turma: quem enviou, a professora regente ou a direcao
app.delete('/api/messages/:id', requireAuth, (req, res) => {
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Mensagem nao encontrada' });
  if (!isTurmaMember(msg.turma_id, req.user.id)) {
    return res.status(403).json({ error: 'Voce nao faz parte desta turma' });
  }
  const isOwn = msg.user_id === req.user.id;
  const isModerator = MODERACAO_TURMA_ROLES.includes(req.user.role);
  if (!isOwn && !isModerator) {
    return res.status(403).json({ error: 'Sem permissao para apagar esta mensagem' });
  }
  db.prepare('UPDATE messages SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE id = ?')
    .run(req.user.id, msg.id);

  io.to('turma_' + msg.turma_id).emit('message_deleted', {
    id: msg.id,
    turmaId: msg.turma_id,
    deletedByName: req.user.name
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Mensagens privadas (conversas 1:1) - responsaveis <-> equipe, nunca pai <-> pai
// ---------------------------------------------------------------------------

// Lista de pessoas com quem o usuario logado tem permissao de iniciar uma conversa nova
app.get('/api/conversations/contacts', requireAuth, (req, res) => {
  const candidates = db.prepare('SELECT * FROM users WHERE id != ? AND active = 1').all(req.user.id);
  const contacts = candidates
    .filter(c => canStartConversation(req.user, c))
    .map(c => ({
      id: c.id, name: c.name, role: c.role, roleLabel: ROLE_LABELS[c.role],
      avatarUrl: c.avatar_filename ? `/api/avatar/${c.id}` : null
    }));
  res.json({ contacts });
});

app.get('/api/conversations', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT c.*,
      CASE WHEN c.user_a_id = ? THEN c.user_b_id ELSE c.user_a_id END as other_id,
      (SELECT content FROM dm_messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) as last_content,
      (SELECT created_at FROM dm_messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) as last_at,
      (SELECT deleted_at FROM dm_messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) as last_deleted_at,
      (SELECT attachment_id FROM dm_messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) as last_attachment_id
    FROM conversations c
    WHERE c.user_a_id = ? OR c.user_b_id = ?
    ORDER BY COALESCE(last_at, c.created_at) DESC
  `).all(req.user.id, req.user.id, req.user.id);

  const conversations = rows.map(r => {
    const other = db.prepare('SELECT id, name, role, avatar_filename FROM users WHERE id = ?').get(r.other_id);
    let preview = null;
    if (r.last_deleted_at) preview = 'Mensagem removida';
    else if (r.last_content) preview = r.last_content;
    else if (r.last_attachment_id) preview = 'Anexo';
    return {
      id: r.id,
      other: {
        id: other.id, name: other.name, role: other.role, roleLabel: ROLE_LABELS[other.role],
        avatarUrl: other.avatar_filename ? `/api/avatar/${other.id}` : null
      },
      lastMessagePreview: preview,
      lastMessageAt: r.last_at || r.created_at
    };
  });
  res.json({ conversations });
});

app.post('/api/conversations', requireAuth, (req, res) => {
  const otherId = Number(req.body.userId);
  const other = db.prepare('SELECT * FROM users WHERE id = ?').get(otherId);
  if (!other) return res.status(404).json({ error: 'Pessoa nao encontrada' });
  if (!canStartConversation(req.user, other)) {
    return res.status(403).json({ error: 'Voce nao pode iniciar uma conversa com esta pessoa' });
  }
  const a = Math.min(req.user.id, otherId);
  const b = Math.max(req.user.id, otherId);
  let conv = db.prepare('SELECT * FROM conversations WHERE user_a_id = ? AND user_b_id = ?').get(a, b);
  if (!conv) {
    const info = db.prepare('INSERT INTO conversations (user_a_id, user_b_id) VALUES (?, ?)').run(a, b);
    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(info.lastInsertRowid);
  }
  res.json({
    conversation: {
      id: conv.id,
      other: {
        id: other.id, name: other.name, role: other.role, roleLabel: ROLE_LABELS[other.role],
        avatarUrl: other.avatar_filename ? `/api/avatar/${other.id}` : null
      }
    }
  });
});

app.get('/api/conversations/:id/messages', requireAuth, requireConversationParticipant, (req, res) => {
  const rows = db.prepare(`
    SELECT m.*, u.name as sender_name, u.role as sender_role, u.avatar_filename as sender_avatar,
           a.id as att_id, a.kind as att_kind, a.original_name as att_name
    FROM dm_messages m
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN attachments a ON a.id = m.attachment_id
    WHERE m.conversation_id = ?
    ORDER BY m.id ASC
    LIMIT 200
  `).all(req.conversationId);

  res.json({
    messages: rows.map(r => ({
      id: r.id,
      content: r.deleted_at ? null : r.content,
      createdAt: r.created_at,
      user: {
        id: r.sender_id, name: r.sender_name, role: r.sender_role, roleLabel: ROLE_LABELS[r.sender_role],
        avatarUrl: r.sender_avatar ? `/api/avatar/${r.sender_id}` : null
      },
      attachment: (!r.deleted_at && r.att_id) ? { id: r.att_id, kind: r.att_kind, name: r.att_name } : null,
      deleted: !!r.deleted_at,
      canDelete: !r.deleted_at && r.sender_id === req.user.id
    }))
  });
});

app.post('/api/conversations/:id/attachments', requireAuth, requireConversationParticipant, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  const kind = req.file.mimetype === 'application/pdf' ? 'pdf' : 'imagem';
  const info = db.prepare(`
    INSERT INTO attachments (conversation_id, uploader_id, filename, original_name, mime, kind)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.conversationId, req.user.id, req.file.filename, req.file.originalname, req.file.mimetype, kind);
  res.json({ attachmentId: info.lastInsertRowid, kind });
});

app.post('/api/conversations/:id/messages', requireAuth, requireConversationParticipant, (req, res) => {
  const { content, attachmentId } = req.body;
  if ((!content || !content.trim()) && !attachmentId) {
    return res.status(400).json({ error: 'Mensagem vazia' });
  }
  if (attachmentId) {
    const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(attachmentId);
    if (!att || att.conversation_id !== req.conversationId) {
      return res.status(400).json({ error: 'Anexo invalido para esta conversa' });
    }
  }
  const info = db.prepare(
    'INSERT INTO dm_messages (conversation_id, sender_id, content, attachment_id) VALUES (?, ?, ?, ?)'
  ).run(req.conversationId, req.user.id, content ? content.trim() : null, attachmentId || null);

  const row = db.prepare(`
    SELECT m.*, u.name as sender_name, u.role as sender_role, u.avatar_filename as sender_avatar,
           a.id as att_id, a.kind as att_kind, a.original_name as att_name
    FROM dm_messages m
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN attachments a ON a.id = m.attachment_id
    WHERE m.id = ?
  `).get(info.lastInsertRowid);

  const payload = {
    id: row.id,
    conversationId: req.conversationId,
    content: row.content,
    createdAt: row.created_at,
    user: {
      id: row.sender_id, name: row.sender_name, role: row.sender_role, roleLabel: ROLE_LABELS[row.sender_role],
      avatarUrl: row.sender_avatar ? `/api/avatar/${row.sender_id}` : null
    },
    attachment: row.att_id ? { id: row.att_id, kind: row.att_kind, name: row.att_name } : null,
    deleted: false,
    canDelete: true
  };

  io.to('conv_' + req.conversationId).emit('new_dm_message', payload);
  res.json({ message: payload });
});

// Apaga (soft delete) uma mensagem privada - somente quem enviou
app.delete('/api/dm-messages/:id', requireAuth, (req, res) => {
  const msg = db.prepare('SELECT * FROM dm_messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Mensagem nao encontrada' });
  if (msg.sender_id !== req.user.id) {
    return res.status(403).json({ error: 'Voce so pode apagar suas proprias mensagens' });
  }
  db.prepare('UPDATE dm_messages SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(msg.id);
  io.to('conv_' + msg.conversation_id).emit('dm_message_deleted', {
    id: msg.id,
    conversationId: msg.conversation_id
  });
  res.json({ ok: true });
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

app.post('/api/cardapio', requireAuth, requireRole(...CARDAPIO_ROLES), (req, res) => {
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

app.delete('/api/cardapio/:id', requireAuth, requireRole(...CARDAPIO_ROLES), (req, res) => {
  const item = db.prepare('SELECT * FROM cardapio WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Nao encontrado' });
  if (item.created_by !== req.user.id && !CARDAPIO_ADMIN_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Somente quem criou ou a direcao/coordenacao pode remover' });
  }
  db.prepare('DELETE FROM cardapio WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Financeiro (prestacao de contas simples)
// ---------------------------------------------------------------------------
app.get('/api/financeiro', requireAuth, (req, res) => {
  const month = req.query.month; // formato YYYY-MM, opcional
  const rows = month
    ? db.prepare(`
        SELECT f.*, u.name as author_name FROM financeiro f JOIN users u ON u.id = f.created_by
        WHERE substr(f.date, 1, 7) = ?
        ORDER BY f.date DESC, f.id DESC
      `).all(month)
    : db.prepare(`
        SELECT f.*, u.name as author_name FROM financeiro f JOIN users u ON u.id = f.created_by
        ORDER BY f.date DESC, f.id DESC
      `).all();
  const totals = rows.reduce((acc, r) => {
    if (r.type === 'receita') acc.receitas += r.amount; else acc.despesas += r.amount;
    return acc;
  }, { receitas: 0, despesas: 0 });
  res.json({ lancamentos: rows, totals: { ...totals, saldo: totals.receitas - totals.despesas } });
});

// Resumo por mes (para o relatorio mensal): totais de receita/despesa/saldo de cada mes com lancamento
app.get('/api/financeiro/resumo-mensal', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT substr(date, 1, 7) as month,
      SUM(CASE WHEN type = 'receita' THEN amount ELSE 0 END) as receitas,
      SUM(CASE WHEN type = 'despesa' THEN amount ELSE 0 END) as despesas
    FROM financeiro
    GROUP BY month
    ORDER BY month DESC
  `).all();
  res.json({
    meses: rows.map(r => ({ month: r.month, receitas: r.receitas, despesas: r.despesas, saldo: r.receitas - r.despesas }))
  });
});

app.post('/api/financeiro', requireAuth, requireRole(...FIN_MANAGE_ROLES), (req, res) => {
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

app.delete('/api/financeiro/:id', requireAuth, requireRole(...FIN_DELETE_ROLES), (req, res) => {
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

  socket.on('join_conversation', (conversationId) => {
    if (isConversationParticipant(Number(conversationId), sess.userId)) {
      socket.join('conv_' + conversationId);
    }
  });

  socket.on('leave_conversation', (conversationId) => {
    socket.leave('conv_' + conversationId);
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
  '/logo.png': 'logo.png',
  '/logo-icon.png': 'logo-icon.png',
  '/manifest.json': 'manifest.json',
  '/icon-192.png': 'icon-192.png',
  '/icon-512.png': 'icon-512.png',
  '/icon-apple-180.png': 'icon-apple-180.png'
};
Object.entries(STATIC_FILES).forEach(([route, file]) => {
  app.get(route, (req, res) => {
    res.sendFile(path.join(__dirname, file));
  });
});

// Service worker: precisa ficar na raiz "/" para poder controlar o site inteiro
// (o escopo de um service worker e limitado a pasta onde o arquivo e servido).
// "no-store" garante que o navegador sempre busque a versao mais nova do sw.js
// assim que ela for publicada, em vez de ficar preso numa versao antiga em cache.
app.get('/sw.js', (req, res) => {
  res.set('Content-Type', 'application/javascript');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'sw.js'));
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
  console.log(`CEI Ângela Amin app rodando em http://localhost:${PORT}`);
  console.log(`Codigo de acesso da equipe (STAFF_CODE): ${STAFF_CODE}`);
});
