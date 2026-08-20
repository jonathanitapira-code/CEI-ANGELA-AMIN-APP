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
const webpush = require('web-push');

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'troque-este-segredo-em-producao';
const STAFF_CODE = process.env.STAFF_CODE || 'creche2026';

// Notificacoes push (aviso de mensagem recebida mesmo com o app fechado):
// so funciona se essas 3 variaveis estiverem configuradas no Render (veja o
// README). Sem elas, o app continua funcionando normalmente, so sem push -
// o chat ao vivo via Socket.IO funciona igual enquanto o app estiver aberto.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:contato@ceiangelaamin.example';
const PUSH_ENABLED = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (PUSH_ENABLED) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('Notificacoes push desativadas: configure VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY nas variaveis de ambiente para ativar.');
}

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
  reply_to_message_id INTEGER REFERENCES messages(id),
  poll_id INTEGER,
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

-- Inscricoes de notificacao push (uma por navegador/aparelho que a pessoa autorizou)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  endpoint TEXT UNIQUE NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Ate onde cada pessoa ja leu em cada turma/conversa (guarda so o id da ultima
-- mensagem lida, nao uma linha por mensagem - mais leve e da pra calcular
-- "nao lidas" e "visto por" a partir disso, igual WhatsApp faz em grupos)
CREATE TABLE IF NOT EXISTS turma_message_reads (
  user_id INTEGER NOT NULL REFERENCES users(id),
  turma_id INTEGER NOT NULL REFERENCES turmas(id),
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, turma_id)
);

CREATE TABLE IF NOT EXISTS conversation_message_reads (
  user_id INTEGER NOT NULL REFERENCES users(id),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, conversation_id)
);

-- Eventos do calendario escolar (reuniao de pais, festa da familia, arraia
-- cultural, entrega de portfolios etc). Feriados nacionais e fins de semana
-- NAO ficam aqui - sao calculados na hora, sem precisar guardar no banco.
CREATE TABLE IF NOT EXISTS calendar_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Mensagens privadas escondidas so para uma pessoa (ela pediu "apagar so pra
-- mim" numa mensagem, ou excluiu a conversa inteira - nesse caso escondemos
-- todas as mensagens que existiam ate aquele momento, de uma vez). A outra
-- pessoa da conversa continua vendo tudo normalmente.
CREATE TABLE IF NOT EXISTS dm_message_hidden (
  message_id INTEGER NOT NULL REFERENCES dm_messages(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  hidden_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (message_id, user_id)
);

-- Enquetes dentro da turma: a pergunta + as opcoes ficam aqui, e a mensagem
-- correspondente (tabela "messages", com poll_id preenchido) e so o que
-- posiciona a enquete no lugar certo da conversa.
CREATE TABLE IF NOT EXISTS polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turma_id INTEGER NOT NULL REFERENCES turmas(id),
  question TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS poll_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES polls(id),
  option_text TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

-- Uma linha por pessoa por enquete (PRIMARY KEY garante "vota so uma vez" -
-- votar de novo so troca a opcao escolhida, nao cria voto duplicado).
CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id INTEGER NOT NULL REFERENCES polls(id),
  option_id INTEGER NOT NULL REFERENCES poll_options(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  voted_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (poll_id, user_id)
);

-- Recados da Direcao: aparecem em tela cheia assim que a pessoa abre o app e
-- so somem depois que ela clica em "Dar ciencia". audience_type = 'all'
-- (todo mundo) ou 'turma' (so quem esta naquela turma especifica).
-- "message" pode ficar vazio quando o recado e so uma imagem/banner/PDF (tem
-- que ter pelo menos um dos dois: texto OU anexo, isso e validado no codigo).
-- As colunas attachment_* guardam o arquivo direto aqui (nao usa a tabela
-- "attachments" porque ela exige turma_id ou conversation_id preenchido).
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  audience_type TEXT NOT NULL DEFAULT 'all' CHECK(audience_type IN ('all','turma')),
  turma_id INTEGER REFERENCES turmas(id),
  attachment_filename TEXT,
  attachment_original_name TEXT,
  attachment_mime TEXT,
  attachment_kind TEXT,
  canceled_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Quem ja deu ciencia de qual recado (PRIMARY KEY garante uma confirmacao
-- por pessoa por recado).
CREATE TABLE IF NOT EXISTS announcement_acks (
  announcement_id INTEGER NOT NULL REFERENCES announcements(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  acked_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (announcement_id, user_id)
);

-- Reacoes as mensagens das turmas (so joinha/positivo e coracao). Uma linha
-- por pessoa por mensagem: reagir de novo com o mesmo emoji remove a reacao
-- (toggle), reagir com o outro emoji troca. PRIMARY KEY garante isso.
CREATE TABLE IF NOT EXISTS message_reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  emoji TEXT NOT NULL CHECK(emoji IN ('👍','❤️')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (message_id, user_id)
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
const messageColumns = db.prepare('PRAGMA table_info(messages)').all().map(c => c.name);
if (!messageColumns.includes('reply_to_message_id')) {
  db.exec('ALTER TABLE messages ADD COLUMN reply_to_message_id INTEGER');
}
if (!messageColumns.includes('poll_id')) {
  db.exec('ALTER TABLE messages ADD COLUMN poll_id INTEGER');
}
const announcementColumns = db.prepare('PRAGMA table_info(announcements)').all().map(c => c.name);
['attachment_filename', 'attachment_original_name', 'attachment_mime', 'attachment_kind'].forEach((col) => {
  if (!announcementColumns.includes(col)) {
    db.exec(`ALTER TABLE announcements ADD COLUMN ${col} TEXT`);
  }
});

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

// ---------------------------------------------------------------------------
// Notificacoes push
// ---------------------------------------------------------------------------

// Quem esta com o socket conectado numa sala agora (turma_X ou conv_X) - essas
// pessoas ja estao vendo a mensagem chegar ao vivo na tela, entao nao precisam
// tambem de uma notificacao push (evita notificar quem ja esta na conversa).
function getUserIdsInRoom(room) {
  const ids = new Set();
  const roomSet = io.sockets.adapter.rooms.get(room);
  if (!roomSet) return ids;
  roomSet.forEach((socketId) => {
    const s = io.sockets.sockets.get(socketId);
    const uid = s && s.request && s.request.session && s.request.session.userId;
    if (uid) ids.add(uid);
  });
  return ids;
}

// Envia notificacao push para uma lista de usuarios (em todos os aparelhos
// que cada um autorizou). Se uma inscricao nao existir mais (a pessoa
// desinstalou o app, trocou de navegador, etc), o servico de push responde
// 404/410 e a gente aproveita para limpar essa inscricao velha do banco.
function sendPushToUsers(userIds, payload) {
  if (!PUSH_ENABLED || !userIds || !userIds.length) return;
  const uniqueIds = [...new Set(userIds)];
  const json = JSON.stringify(payload);
  uniqueIds.forEach((uid) => {
    const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(uid);
    subs.forEach((sub) => {
      const pushSubscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
      webpush.sendNotification(pushSubscription, json).catch((err) => {
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint);
        }
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Mensagens nao lidas / "visto por"
// ---------------------------------------------------------------------------

// Marca que o usuario leu a turma ate a mensagem mais recente que existe agora.
// So avanca o ponteiro (nunca volta pra tras, mesmo se chamado fora de ordem).
function markTurmaRead(turmaId, userId) {
  const row = db.prepare('SELECT MAX(id) as maxId FROM messages WHERE turma_id = ?').get(turmaId);
  const maxId = (row && row.maxId) || 0;
  db.prepare(`
    INSERT INTO turma_message_reads (user_id, turma_id, last_read_message_id, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, turma_id) DO UPDATE SET
      last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id),
      updated_at = CURRENT_TIMESTAMP
  `).run(userId, turmaId, maxId);
  return maxId;
}

function markConversationRead(conversationId, userId) {
  const row = db.prepare('SELECT MAX(id) as maxId FROM dm_messages WHERE conversation_id = ?').get(conversationId);
  const maxId = (row && row.maxId) || 0;
  db.prepare(`
    INSERT INTO conversation_message_reads (user_id, conversation_id, last_read_message_id, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, conversation_id) DO UPDATE SET
      last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id),
      updated_at = CURRENT_TIMESTAMP
  `).run(userId, conversationId, maxId);
  return maxId;
}

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

// Quem pode publicar no cardapio
const CARDAPIO_ROLES = ['cozinha', 'professora_regente', 'professora_auxiliar', 'estagiaria', 'diretora', 'coordenadora_pedagogica', 'gestor'];
// Quem pode remover itens do cardapio criados por outra pessoa
const CARDAPIO_ADMIN_ROLES = ['diretora', 'coordenadora_pedagogica', 'gestor'];
// Quem pode editar (corrigir) qualquer item do cardapio, mesmo criado por
// outra pessoa - grupo especifico pedido para essa funcionalidade
const CARDAPIO_EDIT_ROLES = ['cozinha', 'secretaria', 'coordenadora_pedagogica'];
// Quem pode lancar receitas/despesas
const FIN_MANAGE_ROLES = ['diretora', 'gestor', 'secretaria'];
// Quem pode excluir lancamentos financeiros
const FIN_DELETE_ROLES = ['diretora', 'gestor'];
// Direcao da creche - alcancavel em mensagem privada por qualquer responsavel
const DIRECAO_ROLES = ['diretora', 'coordenadora_pedagogica', 'secretaria', 'gestor'];
// Quem pode criar, editar (renomear) ou excluir definitivamente uma turma -
// Gestor sempre pode (requireRole ja garante isso automaticamente); alem
// dele, so a Direcao (Diretora, Coordenadora Pedagogica, Secretaria).
const TURMA_MANAGE_ROLES = DIRECAO_ROLES;
// Quem pode consultar (auditar) qualquer conversa privada, mesmo sem
// participar dela - usado para a Direcao nao perder o "olho" da creche
// sobre as conversas mesmo depois que a mensagem expira pro responsavel.
const AUDIT_DM_ROLES = DIRECAO_ROLES;
// Depois de quantos dias uma mensagem de conversa privada deixa de aparecer
// para o responsavel (pai/mae) - a outra pessoa da conversa e a Direcao
// continuam vendo normalmente.
const DM_MESSAGE_LIFETIME_DAYS = 5;
// Quem pode criar um recado com ciencia obrigatoria
const RECADO_CREATE_ROLES = DIRECAO_ROLES;
// Quem pode apagar mensagem de outra pessoa dentro do chat da turma
const MODERACAO_TURMA_ROLES = ['professora_regente', ...DIRECAO_ROLES];
// Quem pode editar o calendario escolar (criar/editar/excluir evento). O
// Gestor sempre passa em qualquer checagem (requireRole ja garante isso
// automaticamente), entao so precisa listar aqui quem MAIS, alem dele, pode.
const CALENDARIO_EDIT_ROLES = ['coordenadora_pedagogica'];
// Quem pode encaminhar um recado da turma para o chat de outras turmas
const FORWARD_TARGET_ROLES = ['professora_regente', 'secretaria', 'coordenadora_pedagogica', 'diretora', 'gestor'];
// Quem pode criar enquete dentro de uma turma (nunca responsavel, nunca cozinha)
const POLL_CREATE_ROLES = ['professora_regente', 'professora_auxiliar', 'estagiaria', ...DIRECAO_ROLES];

// Monta a "citacao" de uma mensagem original quando outra mensagem responde
// ela (nome de quem enviou + um resuminho do conteudo).
function getMessageReplyPreview(replyToId) {
  if (!replyToId) return null;
  const orig = db.prepare(`
    SELECT m.id, m.content, m.deleted_at, m.attachment_id, u.name as author_name
    FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?
  `).get(replyToId);
  if (!orig) return null;
  let snippet;
  if (orig.deleted_at) snippet = 'Mensagem removida';
  else if (orig.content) snippet = orig.content.length > 120 ? orig.content.slice(0, 120) + '…' : orig.content;
  else if (orig.attachment_id) snippet = 'Anexo';
  else snippet = '';
  return { id: orig.id, authorName: orig.author_name, snippet };
}

// Reacoes disponiveis (nessa ordem) e resumo de quem reagiu com o que numa
// mensagem. Devolve sempre as duas entradas (mesmo com contagem 0) pra
// simplificar a renderizacao no front. "mine" nao vem daqui: o front compara
// os userIds com o proprio id, assim o mesmo payload serve pra qualquer
// pessoa que olhar (nao precisa recalcular por usuario nem guardar cache
// local pra saber "qual e a minha reacao", como foi preciso fazer nas
// enquetes).
const MESSAGE_REACTION_EMOJIS = ['👍', '❤️'];
function getMessageReactionsPayload(messageId) {
  const rows = db.prepare(`
    SELECT r.emoji, r.user_id, u.name FROM message_reactions r
    JOIN users u ON u.id = r.user_id
    WHERE r.message_id = ?
  `).all(messageId);
  return MESSAGE_REACTION_EMOJIS.map((emoji) => {
    const matches = rows.filter(r => r.emoji === emoji);
    return {
      emoji,
      count: matches.length,
      userIds: matches.map(r => r.user_id),
      names: matches.map(r => r.name)
    };
  });
}

// Monta os dados completos de uma enquete (pergunta, opcoes, contagem de
// votos e quem votou em cada uma - transparente para todo mundo da turma).
function getPollPayload(pollId, forUserId) {
  const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);
  if (!poll) return null;
  const options = db.prepare('SELECT * FROM poll_options WHERE poll_id = ? ORDER BY position, id').all(pollId);
  const votes = db.prepare(`
    SELECT v.option_id, v.user_id, u.name as user_name FROM poll_votes v
    JOIN users u ON u.id = v.user_id WHERE v.poll_id = ?
  `).all(pollId);
  const myVote = votes.find(v => v.user_id === forUserId);
  return {
    id: poll.id,
    question: poll.question,
    options: options.map(o => ({
      id: o.id,
      text: o.option_text,
      count: votes.filter(v => v.option_id === o.id).length,
      voters: votes.filter(v => v.option_id === o.id).map(v => v.user_name)
    })),
    totalVotes: votes.length,
    myOptionId: myVote ? myVote.option_id : null
  };
}

// Quem precisa dar ciencia de um recado: todo mundo ativo (audience 'all')
// ou so quem esta naquela turma (audience 'turma') - sempre menos quem criou
// o recado, que nao precisa confirmar o proprio aviso.
function getAnnouncementAudienceUserIds(announcement) {
  let rows;
  if (announcement.audience_type === 'turma' && announcement.turma_id) {
    rows = db.prepare('SELECT user_id as id FROM turma_members WHERE turma_id = ?').all(announcement.turma_id);
  } else {
    rows = db.prepare('SELECT id FROM users WHERE active = 1').all();
  }
  return rows.map(r => r.id).filter(id => id !== announcement.created_by);
}

// Lista completa da audiencia de um recado com o status de ciencia de cada
// pessoa - usado por quem criou o recado para acompanhar as confirmacoes.
function getAnnouncementAcksPayload(announcement) {
  const audienceIds = getAnnouncementAudienceUserIds(announcement);
  const acks = db.prepare('SELECT user_id, acked_at FROM announcement_acks WHERE announcement_id = ?').all(announcement.id);
  const ackMap = new Map(acks.map(a => [a.user_id, a.acked_at]));
  const people = audienceIds.map((uid) => {
    const u = db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(uid);
    if (!u) return null;
    return {
      id: u.id, name: u.name, roleLabel: ROLE_LABELS[u.role],
      acked: ackMap.has(u.id), ackedAt: ackMap.get(u.id) || null
    };
  }).filter(Boolean).sort((a, b) => (a.acked === b.acked) ? a.name.localeCompare(b.name) : (a.acked ? 1 : -1));
  return {
    total: people.length,
    ackedCount: people.filter(p => p.acked).length,
    people
  };
}

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
// Notificacoes push (aviso de mensagem recebida mesmo com o app fechado)
// ---------------------------------------------------------------------------

// Chave publica usada pelo navegador para se inscrever (nao e segredo).
app.get('/api/push/vapid-public-key', requireAuth, (req, res) => {
  res.json({ publicKey: PUSH_ENABLED ? VAPID_PUBLIC_KEY : null });
});

app.post('/api/push/subscribe', requireAuth, (req, res) => {
  if (!PUSH_ENABLED) return res.status(503).json({ error: 'Notificacoes push nao estao configuradas neste servidor' });
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: 'Inscricao de notificacao invalida' });
  }
  db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth
  `).run(req.user.id, endpoint, keys.p256dh, keys.auth);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, req.user.id);
  res.json({ ok: true });
});

// Apaga um anexo (foto/PDF) de vez: tira o arquivo do disco e a linha do
// banco. Usado tanto na exclusao de turma quanto na purga automatica de
// mensagens antigas - e o que realmente libera espaco no disco do Render.
function deleteAttachmentById(attachmentId) {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(attachmentId);
  if (!att) return;
  const filePath = path.join(UPLOAD_DIR, att.filename);
  fs.unlink(filePath, () => {}); // silencioso: se o arquivo ja nao existir, tudo bem
  db.prepare('DELETE FROM attachments WHERE id = ?').run(attachmentId);
}

// ---------------------------------------------------------------------------
// Turmas
// ---------------------------------------------------------------------------
app.post('/api/turmas', requireAuth, requireRole(...TURMA_MANAGE_ROLES), (req, res) => {
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

// Renomeia uma turma (Gestor ou Direcao, mesmo sem ser membro dela).
app.put('/api/turmas/:id', requireAuth, requireRole(...TURMA_MANAGE_ROLES), (req, res) => {
  const turma = db.prepare('SELECT * FROM turmas WHERE id = ?').get(req.params.id);
  if (!turma) return res.status(404).json({ error: 'Turma nao encontrada' });
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Informe o nome da turma' });
  db.prepare('UPDATE turmas SET name = ? WHERE id = ?').run(name.trim(), turma.id);
  const updated = db.prepare('SELECT * FROM turmas WHERE id = ?').get(turma.id);
  io.to('turma_' + turma.id).emit('turma_renamed', { turmaId: turma.id, name: updated.name });
  res.json({ turma: updated });
});

// Exclui uma turma DEFINITIVAMENTE - mensagens, anexos (inclusive os
// arquivos no disco), enquetes e a lista de participantes somem junto.
// Nao tem como desfazer, entao so Gestor/Direcao podem, mesmo sem ser
// membros da turma.
app.delete('/api/turmas/:id', requireAuth, requireRole(...TURMA_MANAGE_ROLES), (req, res) => {
  const turma = db.prepare('SELECT * FROM turmas WHERE id = ?').get(req.params.id);
  if (!turma) return res.status(404).json({ error: 'Turma nao encontrada' });

  const messages = db.prepare('SELECT id, attachment_id, poll_id FROM messages WHERE turma_id = ?').all(turma.id);
  const attachmentIds = messages.map(m => m.attachment_id).filter(Boolean);
  const pollIds = messages.map(m => m.poll_id).filter(Boolean);

  const runDelete = db.transaction(() => {
    attachmentIds.forEach((attId) => deleteAttachmentById(attId));
    pollIds.forEach((pollId) => {
      db.prepare('DELETE FROM poll_votes WHERE poll_id = ?').run(pollId);
      db.prepare('DELETE FROM poll_options WHERE poll_id = ?').run(pollId);
      db.prepare('DELETE FROM polls WHERE id = ?').run(pollId);
    });
    db.prepare('DELETE FROM turma_message_reads WHERE turma_id = ?').run(turma.id);
    messages.forEach((m) => db.prepare('DELETE FROM message_reactions WHERE message_id = ?').run(m.id));
    db.prepare('DELETE FROM messages WHERE turma_id = ?').run(turma.id);
    db.prepare('DELETE FROM turma_members WHERE turma_id = ?').run(turma.id);
    db.prepare('DELETE FROM turmas WHERE id = ?').run(turma.id);
  });
  runDelete();

  io.to('turma_' + turma.id).emit('turma_deleted', { turmaId: turma.id });
  res.json({ ok: true });
});

// Subquery reaproveitada nas duas variantes abaixo: quantas mensagens da
// turma essa pessoa ainda nao leu (nunca conta mensagem que ela mesma enviou).
const UNREAD_TURMA_SUBQUERY = `(
  SELECT COUNT(*) FROM messages m
  WHERE m.turma_id = t.id AND m.user_id != ? AND m.deleted_at IS NULL
    AND m.id > COALESCE((SELECT last_read_message_id FROM turma_message_reads WHERE user_id = ? AND turma_id = t.id), 0)
) as unread_count`;

app.get('/api/turmas', requireAuth, (req, res) => {
  // Gestor enxerga todas as turmas da creche (acesso total), mesmo sem ter entrado nelas
  const turmas = req.user.role === 'gestor'
    ? db.prepare(`
        SELECT t.*, (SELECT COUNT(*) FROM turma_members m WHERE m.turma_id = t.id) as member_count,
          ${UNREAD_TURMA_SUBQUERY}
        FROM turmas t
        ORDER BY t.created_at DESC
      `).all(req.user.id, req.user.id)
    : db.prepare(`
        SELECT t.*, (SELECT COUNT(*) FROM turma_members m WHERE m.turma_id = t.id) as member_count,
          ${UNREAD_TURMA_SUBQUERY}
        FROM turmas t
        JOIN turma_members tm ON tm.turma_id = t.id
        WHERE tm.user_id = ?
        ORDER BY t.created_at DESC
      `).all(req.user.id, req.user.id, req.user.id);
  res.json({ turmas });
});

// Lista simples (so id + nome) de TODAS as turmas da creche, mesmo as que a
// pessoa nao e membro - usado no seletor de turma ao criar um recado, ja que
// Direcao/Gestor podem mandar recado pra qualquer turma.
app.get('/api/turmas/all', requireAuth, requireRole(...TURMA_MANAGE_ROLES), (req, res) => {
  const turmas = db.prepare('SELECT id, name FROM turmas ORDER BY name').all();
  res.json({ turmas });
});

// Marca a turma como lida ate a mensagem mais recente (chamado ao abrir o chat
// e quando uma mensagem nova chega enquanto o chat ja esta aberto na tela).
app.post('/api/turmas/:id/read', requireAuth, requireTurmaMember, (req, res) => {
  const lastReadMessageId = markTurmaRead(req.turmaId, req.user.id);
  io.to('turma_' + req.turmaId).emit('turma_read_update', {
    turmaId: req.turmaId, userId: req.user.id, userName: req.user.name, lastReadMessageId
  });
  res.json({ ok: true, lastReadMessageId });
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

  // Quem ja leu ate onde, nessa turma (usado pra calcular "visto por" de cada
  // mensagem sem precisar de uma linha por mensagem lida).
  const readsForTurma = db.prepare(`
    SELECT tm.user_id, u.name, COALESCE(r.last_read_message_id, 0) as last_read_message_id
    FROM turma_members tm
    JOIN users u ON u.id = tm.user_id
    LEFT JOIN turma_message_reads r ON r.user_id = tm.user_id AND r.turma_id = tm.turma_id
    WHERE tm.turma_id = ?
  `).all(req.turmaId);

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
      canDelete: !r.deleted_at && (r.user_id === req.user.id || MODERACAO_TURMA_ROLES.includes(req.user.role)),
      readBy: readsForTurma
        .filter(mr => mr.user_id !== r.user_id && mr.last_read_message_id >= r.id)
        .map(mr => mr.name),
      replyTo: getMessageReplyPreview(r.reply_to_message_id),
      poll: r.poll_id ? getPollPayload(r.poll_id, req.user.id) : null,
      reactions: r.deleted_at ? [] : getMessageReactionsPayload(r.id)
    }))
  });
});

// Cria uma mensagem de texto/anexo numa turma e cuida de todos os efeitos
// colaterais (emitir pro chat ao vivo, notificar push, atualizar nao lidas,
// marcar como lida pra quem enviou). Reaproveitada pelo envio normal de
// mensagem e pelo "encaminhar recado para outras turmas".
function createTurmaMessage(turmaId, userId, content, attachmentId, replyToId) {
  const info = db.prepare(
    'INSERT INTO messages (turma_id, user_id, content, attachment_id, reply_to_message_id) VALUES (?, ?, ?, ?, ?)'
  ).run(turmaId, userId, content ? content.trim() : null, attachmentId || null, replyToId || null);

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
    turmaId: turmaId,
    content: row.content,
    createdAt: row.created_at,
    user: {
      id: row.user_id, name: row.user_name, role: row.user_role, roleLabel: ROLE_LABELS[row.user_role],
      avatarUrl: row.user_avatar ? `/api/avatar/${row.user_id}` : null
    },
    attachment: row.att_id ? { id: row.att_id, kind: row.att_kind, name: row.att_name } : null,
    deleted: false,
    deletedByName: null,
    canDelete: row.user_id === userId,
    readBy: [],
    replyTo: getMessageReplyPreview(replyToId),
    poll: null,
    reactions: getMessageReactionsPayload(row.id)
  };

  io.to('turma_' + turmaId).emit('new_message', payload);

  // Notifica push quem e da turma, exceto quem enviou e quem ja esta com o
  // chat dessa turma aberto na tela (essa pessoa ja viu a mensagem chegar).
  const turmaRow = db.prepare('SELECT name FROM turmas WHERE id = ?').get(turmaId);
  const memberIds = db.prepare('SELECT user_id FROM turma_members WHERE turma_id = ?').all(turmaId).map(r => r.user_id);
  const viewingNow = getUserIdsInRoom('turma_' + turmaId);
  const notifyIds = memberIds.filter(uid => uid !== userId && !viewingNow.has(uid));
  sendPushToUsers(notifyIds, {
    title: turmaRow ? turmaRow.name : 'Nova mensagem',
    body: row.content ? `${row.user_name}: ${row.content}` : `${row.user_name} enviou ${row.att_kind === 'pdf' ? 'um PDF' : 'uma foto'}`,
    url: `/?openTurma=${turmaId}`
  });
  // Avisa (na sala pessoal) quem nao esta vendo esse chat agora pra atualizar
  // o numerinho de nao lidas na lista de turmas, sem precisar recarregar.
  notifyIds.forEach((uid) => io.to('user_' + uid).emit('unread_bump', { kind: 'turma', id: turmaId }));

  // Quem enviou tambem "leu" ate a propria mensagem (mantem o ponteiro em dia).
  markTurmaRead(turmaId, userId);

  return payload;
}

app.post('/api/turmas/:id/messages', requireAuth, requireTurmaMember, (req, res) => {
  const { content, attachmentId, replyToMessageId } = req.body;
  if ((!content || !content.trim()) && !attachmentId) {
    return res.status(400).json({ error: 'Mensagem vazia' });
  }
  if (attachmentId) {
    const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(attachmentId);
    if (!att || att.turma_id !== req.turmaId) {
      return res.status(400).json({ error: 'Anexo invalido para esta turma' });
    }
  }
  let replyToId = null;
  if (replyToMessageId) {
    const replyTarget = db.prepare('SELECT id FROM messages WHERE id = ? AND turma_id = ?').get(replyToMessageId, req.turmaId);
    if (replyTarget) replyToId = replyTarget.id;
  }
  const payload = createTurmaMessage(req.turmaId, req.user.id, content, attachmentId, replyToId);
  res.json({ message: payload });
});

// Reagir (joinha/coracao) a uma mensagem da turma. Clicar de novo no mesmo
// emoji remove a reacao; clicar no outro emoji troca. Qualquer membro da
// turma pode reagir, inclusive na propria mensagem.
app.post('/api/turmas/:id/messages/:msgId/react', requireAuth, requireTurmaMember, (req, res) => {
  const msg = db.prepare('SELECT id, deleted_at FROM messages WHERE id = ? AND turma_id = ?').get(req.params.msgId, req.turmaId);
  if (!msg) return res.status(404).json({ error: 'Mensagem nao encontrada' });
  if (msg.deleted_at) return res.status(400).json({ error: 'Esta mensagem foi removida' });

  const emoji = req.body.emoji;
  if (!MESSAGE_REACTION_EMOJIS.includes(emoji)) {
    return res.status(400).json({ error: 'Reacao invalida' });
  }

  const existing = db.prepare('SELECT emoji FROM message_reactions WHERE message_id = ? AND user_id = ?').get(msg.id, req.user.id);
  if (existing && existing.emoji === emoji) {
    db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?').run(msg.id, req.user.id);
  } else {
    db.prepare(`
      INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)
      ON CONFLICT(message_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = CURRENT_TIMESTAMP
    `).run(msg.id, req.user.id, emoji);
  }

  const reactions = getMessageReactionsPayload(msg.id);
  io.to('turma_' + req.turmaId).emit('message_reaction_update', { turmaId: req.turmaId, messageId: msg.id, reactions });
  res.json({ reactions });
});

// Lista de turmas para as quais e possivel encaminhar um recado desta turma
// (todas as outras turmas da creche, ja que quem encaminha e sempre alguem
// da equipe com alcance sobre a creche toda - Regente, Secretaria, Coord.
// Pedagogica, Diretora ou Gestor).
app.get('/api/turmas/:id/forward-targets', requireAuth, requireTurmaMember, requireRole(...FORWARD_TARGET_ROLES), (req, res) => {
  const targets = db.prepare('SELECT id, name FROM turmas WHERE id != ? ORDER BY name').all(req.turmaId);
  res.json({ targets });
});

// Encaminha um recado de texto desta turma para o chat de uma ou mais outras
// turmas (broadcast). So funciona com mensagens que tem texto (anexos nao
// podem ser encaminhados por aqui). Restrito a Professora Regente, Secretaria,
// Coordenadora Pedagogica, Diretora e Gestor.
app.post('/api/turmas/:id/messages/:msgId/forward', requireAuth, requireTurmaMember, requireRole(...FORWARD_TARGET_ROLES), (req, res) => {
  const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND turma_id = ?').get(req.params.msgId, req.turmaId);
  if (!msg) return res.status(404).json({ error: 'Mensagem nao encontrada' });
  if (msg.deleted_at) return res.status(400).json({ error: 'Esta mensagem foi removida e nao pode ser encaminhada' });
  if (!msg.content || !msg.content.trim()) {
    return res.status(400).json({ error: 'So e possivel encaminhar mensagens com texto' });
  }
  const toTurmaIds = Array.isArray(req.body.toTurmaIds) ? [...new Set(req.body.toTurmaIds.map(Number))] : [];
  if (!toTurmaIds.length) {
    return res.status(400).json({ error: 'Escolha pelo menos uma turma para encaminhar' });
  }
  const validTurmas = db.prepare(
    `SELECT id, name FROM turmas WHERE id IN (${toTurmaIds.map(() => '?').join(',')}) AND id != ?`
  ).all(...toTurmaIds, req.turmaId);
  if (!validTurmas.length) {
    return res.status(400).json({ error: 'Nenhuma turma valida selecionada' });
  }

  const turma = db.prepare('SELECT name FROM turmas WHERE id = ?').get(req.turmaId);
  const originalSender = db.prepare('SELECT name FROM users WHERE id = ?').get(msg.user_id);
  const forwardedContent = `↪️ Encaminhado da turma "${turma ? turma.name : ''}" (${originalSender ? originalSender.name : 'alguem'}):\n${msg.content}`;

  const sent = validTurmas.map((t) => {
    const payload = createTurmaMessage(t.id, req.user.id, forwardedContent, null, null);
    return { turmaId: t.id, turmaName: t.name, message: payload };
  });

  res.json({ sent });
});

// ---------------------------------------------------------------------------
// Enquetes dentro da turma
// ---------------------------------------------------------------------------

// Cria a enquete (pergunta + opcoes) e uma "mensagem" pra ela aparecer no
// lugar certo do chat, em tempo real pra quem esta na turma agora.
app.post('/api/turmas/:id/polls', requireAuth, requireTurmaMember, requireRole(...POLL_CREATE_ROLES), (req, res) => {
  const { question } = req.body;
  const options = Array.isArray(req.body.options) ? req.body.options.map(o => (o || '').trim()).filter(Boolean) : [];
  if (!question || !question.trim()) {
    return res.status(400).json({ error: 'Informe a pergunta da enquete' });
  }
  if (options.length < 2) {
    return res.status(400).json({ error: 'Informe pelo menos 2 opcoes' });
  }
  if (options.length > 8) {
    return res.status(400).json({ error: 'No maximo 8 opcoes' });
  }

  const pollInfo = db.prepare(
    'INSERT INTO polls (turma_id, question, created_by) VALUES (?, ?, ?)'
  ).run(req.turmaId, question.trim(), req.user.id);
  const pollId = pollInfo.lastInsertRowid;

  const insertOption = db.prepare('INSERT INTO poll_options (poll_id, option_text, position) VALUES (?, ?, ?)');
  options.forEach((text, idx) => insertOption.run(pollId, text, idx));

  const msgInfo = db.prepare(
    'INSERT INTO messages (turma_id, user_id, poll_id) VALUES (?, ?, ?)'
  ).run(req.turmaId, req.user.id, pollId);

  const msgRow = db.prepare(`
    SELECT msg.*, u.name as user_name, u.role as user_role, u.avatar_filename as user_avatar
    FROM messages msg JOIN users u ON u.id = msg.user_id WHERE msg.id = ?
  `).get(msgInfo.lastInsertRowid);

  const payload = {
    id: msgRow.id,
    turmaId: req.turmaId,
    content: null,
    createdAt: msgRow.created_at,
    user: {
      id: msgRow.user_id, name: msgRow.user_name, role: msgRow.user_role, roleLabel: ROLE_LABELS[msgRow.user_role],
      avatarUrl: msgRow.user_avatar ? `/api/avatar/${msgRow.user_id}` : null
    },
    attachment: null,
    deleted: false,
    deletedByName: null,
    canDelete: false,
    readBy: [],
    replyTo: null,
    poll: getPollPayload(pollId, req.user.id)
  };

  io.to('turma_' + req.turmaId).emit('new_message', payload);

  const memberIds = db.prepare('SELECT user_id FROM turma_members WHERE turma_id = ?').all(req.turmaId).map(r => r.user_id);
  const viewingNow = getUserIdsInRoom('turma_' + req.turmaId);
  const notifyIds = memberIds.filter(uid => uid !== req.user.id && !viewingNow.has(uid));
  const turmaRow = db.prepare('SELECT name FROM turmas WHERE id = ?').get(req.turmaId);
  sendPushToUsers(notifyIds, {
    title: turmaRow ? turmaRow.name : 'Nova enquete',
    body: `${msgRow.user_name} criou uma enquete: ${question.trim()}`,
    url: `/?openTurma=${req.turmaId}`
  });
  notifyIds.forEach((uid) => io.to('user_' + uid).emit('unread_bump', { kind: 'turma', id: req.turmaId }));
  markTurmaRead(req.turmaId, req.user.id);

  res.json({ message: payload });
});

// Vota (ou troca o voto) numa enquete. Uma pessoa so tem um voto valendo por
// vez - votar de novo so substitui a escolha anterior.
app.post('/api/turmas/:id/polls/:pollId/vote', requireAuth, requireTurmaMember, (req, res) => {
  const poll = db.prepare('SELECT * FROM polls WHERE id = ? AND turma_id = ?').get(req.params.pollId, req.turmaId);
  if (!poll) return res.status(404).json({ error: 'Enquete nao encontrada' });
  const option = db.prepare('SELECT * FROM poll_options WHERE id = ? AND poll_id = ?').get(req.body.optionId, poll.id);
  if (!option) return res.status(400).json({ error: 'Opcao invalida' });

  db.prepare(`
    INSERT INTO poll_votes (poll_id, option_id, user_id, voted_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(poll_id, user_id) DO UPDATE SET option_id = excluded.option_id, voted_at = CURRENT_TIMESTAMP
  `).run(poll.id, option.id, req.user.id);

  // Manda o resultado atualizado (com nomes de quem votou) pra quem esta com
  // a turma aberta agora, sem precisar recarregar.
  io.to('turma_' + req.turmaId).emit('poll_vote_update', {
    turmaId: req.turmaId,
    pollId: poll.id,
    poll: getPollPayload(poll.id, null) // "null" so pra reaproveitar a funcao; myOptionId nao e usado aqui
  });
  res.json({ ok: true, poll: getPollPayload(poll.id, req.user.id) });
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

// Acha a conversa entre duas pessoas ou cria uma nova, se ainda nao existir.
function findOrCreateConversation(userIdA, userIdB) {
  const a = Math.min(userIdA, userIdB);
  const b = Math.max(userIdA, userIdB);
  let conv = db.prepare('SELECT * FROM conversations WHERE user_a_id = ? AND user_b_id = ?').get(a, b);
  if (!conv) {
    const info = db.prepare('INSERT INTO conversations (user_a_id, user_b_id) VALUES (?, ?)').run(a, b);
    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(info.lastInsertRowid);
  }
  return conv;
}

// Cria uma mensagem privada e cuida de tudo que precisa acontecer depois:
// avisar quem esta com a conversa aberta (Socket.IO), notificar push/numero
// de nao lidas quem nao esta vendo agora, e marcar que quem enviou "leu" a
// propria mensagem. Usado tanto pelo envio normal quanto pelo "encaminhar".
function createDmMessage(conversationId, senderId, content, attachmentId) {
  const info = db.prepare(
    'INSERT INTO dm_messages (conversation_id, sender_id, content, attachment_id) VALUES (?, ?, ?, ?)'
  ).run(conversationId, senderId, content || null, attachmentId || null);

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
    conversationId,
    content: row.content,
    createdAt: row.created_at,
    user: {
      id: row.sender_id, name: row.sender_name, role: row.sender_role, roleLabel: ROLE_LABELS[row.sender_role],
      avatarUrl: row.sender_avatar ? `/api/avatar/${row.sender_id}` : null
    },
    attachment: row.att_id ? { id: row.att_id, kind: row.att_kind, name: row.att_name } : null,
    deleted: false,
    canDelete: true,
    seenByOther: false
  };

  io.to('conv_' + conversationId).emit('new_dm_message', payload);

  const convRow = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  if (convRow) {
    const otherId = convRow.user_a_id === senderId ? convRow.user_b_id : convRow.user_a_id;
    const viewingNow = getUserIdsInRoom('conv_' + conversationId);
    if (!viewingNow.has(otherId)) {
      sendPushToUsers([otherId], {
        title: row.sender_name,
        body: row.content ? row.content : `Enviou ${row.att_kind === 'pdf' ? 'um PDF' : 'uma foto'}`,
        url: `/?openConversation=${conversationId}`
      });
      io.to('user_' + otherId).emit('unread_bump', { kind: 'conversation', id: conversationId });
    }
  }
  markConversationRead(conversationId, senderId);

  return payload;
}

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
  // "Nao escondida para mim" = a mensagem nao tem linha em dm_message_hidden
  // para o meu usuario (ou seja, eu nao pedi pra apagar ela so pra mim).
  const NOT_HIDDEN = `NOT IN (SELECT message_id FROM dm_message_hidden WHERE user_id = ?)`;
  // Responsavel (pai/mae) deixa de enxergar mensagens de conversa privada com
  // mais de 5 dias (a Direcao sempre pode consultar via auditoria); para
  // qualquer outro cargo essa condicao fica vazia (sem filtro por idade).
  const AGE_OK = req.user.role === 'pai'
    ? `AND created_at >= datetime('now', '-${DM_MESSAGE_LIFETIME_DAYS} days')`
    : '';
  const rows = db.prepare(`
    SELECT c.*,
      CASE WHEN c.user_a_id = ? THEN c.user_b_id ELSE c.user_a_id END as other_id,
      (SELECT content FROM dm_messages WHERE conversation_id = c.id AND id ${NOT_HIDDEN} ${AGE_OK} ORDER BY id DESC LIMIT 1) as last_content,
      (SELECT created_at FROM dm_messages WHERE conversation_id = c.id AND id ${NOT_HIDDEN} ${AGE_OK} ORDER BY id DESC LIMIT 1) as last_at,
      (SELECT deleted_at FROM dm_messages WHERE conversation_id = c.id AND id ${NOT_HIDDEN} ${AGE_OK} ORDER BY id DESC LIMIT 1) as last_deleted_at,
      (SELECT attachment_id FROM dm_messages WHERE conversation_id = c.id AND id ${NOT_HIDDEN} ${AGE_OK} ORDER BY id DESC LIMIT 1) as last_attachment_id,
      (
        SELECT COUNT(*) FROM dm_messages m
        WHERE m.conversation_id = c.id AND m.sender_id != ? AND m.deleted_at IS NULL AND m.id ${NOT_HIDDEN}
          AND m.id > COALESCE((SELECT last_read_message_id FROM conversation_message_reads WHERE user_id = ? AND conversation_id = c.id), 0)
          ${AGE_OK ? 'AND m.created_at >= datetime(\'now\', \'-' + DM_MESSAGE_LIFETIME_DAYS + ' days\')' : ''}
      ) as unread_count
    FROM conversations c
    WHERE (c.user_a_id = ? OR c.user_b_id = ?)
      AND (
        NOT EXISTS (SELECT 1 FROM dm_messages m WHERE m.conversation_id = c.id)
        OR EXISTS (SELECT 1 FROM dm_messages m WHERE m.conversation_id = c.id AND m.id ${NOT_HIDDEN} ${AGE_OK})
      )
    ORDER BY COALESCE(last_at, c.created_at) DESC
  `).all(
    req.user.id, // CASE WHEN
    req.user.id, req.user.id, req.user.id, req.user.id, // 4x NOT_HIDDEN nas subconsultas de preview
    req.user.id, req.user.id, req.user.id, // unread_count: sender_id !=, NOT_HIDDEN, last_read_message_id
    req.user.id, req.user.id, // WHERE user_a_id/user_b_id
    req.user.id // NOT_HIDDEN na visibilidade da conversa
  );

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
      lastMessageAt: r.last_at || r.created_at,
      unread_count: r.unread_count
    };
  });
  res.json({ conversations });
});

// Marca a conversa como lida ate a mensagem mais recente.
app.post('/api/conversations/:id/read', requireAuth, requireConversationParticipant, (req, res) => {
  const lastReadMessageId = markConversationRead(req.conversationId, req.user.id);
  io.to('conv_' + req.conversationId).emit('conversation_read_update', {
    conversationId: req.conversationId, userId: req.user.id, lastReadMessageId
  });
  res.json({ ok: true, lastReadMessageId });
});

// Exclui a conversa - so para quem pediu. Esconde todas as mensagens que
// existem ate agora (so para essa pessoa); a outra pessoa continua vendo tudo
// normalmente. Se chegar mensagem nova depois, a conversa reaparece sozinha
// na lista (so as mensagens novas ficam visiveis).
app.delete('/api/conversations/:id', requireAuth, requireConversationParticipant, (req, res) => {
  const messageIds = db.prepare('SELECT id FROM dm_messages WHERE conversation_id = ?').all(req.conversationId);
  const insert = db.prepare('INSERT OR IGNORE INTO dm_message_hidden (message_id, user_id) VALUES (?, ?)');
  const insertMany = db.transaction((ids) => {
    ids.forEach((row) => insert.run(row.id, req.user.id));
  });
  insertMany(messageIds);
  res.json({ ok: true });
});

app.post('/api/conversations', requireAuth, (req, res) => {
  const otherId = Number(req.body.userId);
  const other = db.prepare('SELECT * FROM users WHERE id = ?').get(otherId);
  if (!other) return res.status(404).json({ error: 'Pessoa nao encontrada' });
  if (!canStartConversation(req.user, other)) {
    return res.status(403).json({ error: 'Voce nao pode iniciar uma conversa com esta pessoa' });
  }
  const conv = findOrCreateConversation(req.user.id, otherId);
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
  // Responsavel deixa de ver mensagens com mais de 5 dias (veja DM_MESSAGE_LIFETIME_DAYS).
  const ageFilter = req.user.role === 'pai'
    ? `AND m.created_at >= datetime('now', '-${DM_MESSAGE_LIFETIME_DAYS} days')`
    : '';
  const rows = db.prepare(`
    SELECT m.*, u.name as sender_name, u.role as sender_role, u.avatar_filename as sender_avatar,
           a.id as att_id, a.kind as att_kind, a.original_name as att_name
    FROM dm_messages m
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN attachments a ON a.id = m.attachment_id
    WHERE m.conversation_id = ?
      AND m.id NOT IN (SELECT message_id FROM dm_message_hidden WHERE user_id = ?)
      ${ageFilter}
    ORDER BY m.id ASC
    LIMIT 200
  `).all(req.conversationId, req.user.id);

  // Ate onde a outra pessoa da conversa ja leu, pra marcar "visto" nas minhas
  // proprias mensagens.
  const convRowForRead = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.conversationId);
  const otherIdForRead = convRowForRead
    ? (convRowForRead.user_a_id === req.user.id ? convRowForRead.user_b_id : convRowForRead.user_a_id)
    : null;
  const otherReadRow = otherIdForRead
    ? db.prepare('SELECT last_read_message_id FROM conversation_message_reads WHERE user_id = ? AND conversation_id = ?').get(otherIdForRead, req.conversationId)
    : null;
  const otherLastReadId = otherReadRow ? otherReadRow.last_read_message_id : 0;

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
      canDelete: !r.deleted_at && r.sender_id === req.user.id,
      seenByOther: r.sender_id === req.user.id && r.id <= otherLastReadId
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
  const payload = createDmMessage(req.conversationId, req.user.id, content ? content.trim() : null, attachmentId || null);
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

// Apaga uma mensagem privada so para quem esta pedindo (a outra pessoa da
// conversa continua vendo normalmente). Qualquer participante pode usar isso
// em qualquer mensagem, mesmo enviada pela outra pessoa - diferente do apagar
// "pra todos" acima, que so quem enviou pode fazer.
app.post('/api/dm-messages/:id/hide-for-me', requireAuth, (req, res) => {
  const msg = db.prepare('SELECT * FROM dm_messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Mensagem nao encontrada' });
  if (!isConversationParticipant(msg.conversation_id, req.user.id)) {
    return res.status(403).json({ error: 'Voce nao faz parte desta conversa' });
  }
  db.prepare('INSERT OR IGNORE INTO dm_message_hidden (message_id, user_id) VALUES (?, ?)').run(msg.id, req.user.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Auditoria de conversas privadas (Direcao) - consulta qualquer conversa,
// mesmo sem participar dela, inclusive mensagens que ja expiraram da tela do
// responsavel (a idade nao e filtrada aqui de proposito).
// ---------------------------------------------------------------------------
app.get('/api/admin/conversations', requireAuth, requireRole(...AUDIT_DM_ROLES), (req, res) => {
  const rows = db.prepare(`
    SELECT c.*,
      (SELECT content FROM dm_messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) as last_content,
      (SELECT created_at FROM dm_messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) as last_at,
      (SELECT deleted_at FROM dm_messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) as last_deleted_at,
      (SELECT attachment_id FROM dm_messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) as last_attachment_id,
      (SELECT COUNT(*) FROM dm_messages WHERE conversation_id = c.id) as message_count
    FROM conversations c
    ORDER BY COALESCE(last_at, c.created_at) DESC
  `).all();
  const conversations = rows.map(r => {
    const a = db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(r.user_a_id);
    const b = db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(r.user_b_id);
    let preview = null;
    if (r.last_deleted_at) preview = 'Mensagem removida';
    else if (r.last_content) preview = r.last_content;
    else if (r.last_attachment_id) preview = 'Anexo';
    return {
      id: r.id,
      userA: a ? { id: a.id, name: a.name, roleLabel: ROLE_LABELS[a.role] } : null,
      userB: b ? { id: b.id, name: b.name, roleLabel: ROLE_LABELS[b.role] } : null,
      lastMessagePreview: preview,
      lastMessageAt: r.last_at || r.created_at,
      messageCount: r.message_count
    };
  });
  res.json({ conversations });
});

// Historico completo de qualquer conversa, sem filtro de idade nem de
// mensagens escondidas - visao de auditoria, somente leitura.
app.get('/api/admin/conversations/:id/messages', requireAuth, requireRole(...AUDIT_DM_ROLES), (req, res) => {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversa nao encontrada' });
  const rows = db.prepare(`
    SELECT m.*, u.name as sender_name, u.role as sender_role, u.avatar_filename as sender_avatar,
           a.id as att_id, a.kind as att_kind, a.original_name as att_name
    FROM dm_messages m
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN attachments a ON a.id = m.attachment_id
    WHERE m.conversation_id = ?
    ORDER BY m.id ASC
    LIMIT 500
  `).all(conv.id);
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
      deleted: !!r.deleted_at
    }))
  });
});

// ---------------------------------------------------------------------------
// Recados com ciencia obrigatoria (aparecem em tela cheia ao abrir o app)
// ---------------------------------------------------------------------------

// Monta o objeto "attachment" (se tiver) a partir de uma linha de announcements.
function getAnnouncementAttachment(a) {
  if (!a.attachment_filename) return null;
  return { kind: a.attachment_kind, name: a.attachment_original_name };
}

// Cria um recado novo (texto e/ou uma imagem/PDF - "banner") e avisa ao vivo
// (via socket) quem precisa ver.
app.post('/api/recados', requireAuth, requireRole(...RECADO_CREATE_ROLES), upload.single('file'), (req, res) => {
  const { message, audienceType, turmaId } = req.body;
  const hasText = message && message.trim();
  const hasFile = !!req.file;
  if (!hasText && !hasFile) {
    return res.status(400).json({ error: 'Escreva o recado ou anexe uma imagem/PDF' });
  }
  if (!['all', 'turma'].includes(audienceType)) {
    return res.status(400).json({ error: 'Escolha para quem e o recado' });
  }
  let resolvedTurmaId = null;
  if (audienceType === 'turma') {
    const turma = db.prepare('SELECT id FROM turmas WHERE id = ?').get(turmaId);
    if (!turma) return res.status(400).json({ error: 'Turma invalida' });
    resolvedTurmaId = turma.id;
  }
  const info = db.prepare(`
    INSERT INTO announcements (message, created_by, audience_type, turma_id, attachment_filename, attachment_original_name, attachment_mime, attachment_kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    // Usa string vazia (nunca null) para o texto quando o recado e so
    // imagem/PDF - assim funciona mesmo em bancos antigos onde a coluna
    // "message" exige um valor preenchido.
    hasText ? message.trim() : '', req.user.id, audienceType, resolvedTurmaId,
    hasFile ? req.file.filename : null,
    hasFile ? req.file.originalname : null,
    hasFile ? req.file.mimetype : null,
    hasFile ? (req.file.mimetype === 'application/pdf' ? 'pdf' : 'imagem') : null
  );
  const announcement = db.prepare('SELECT * FROM announcements WHERE id = ?').get(info.lastInsertRowid);

  const audienceIds = getAnnouncementAudienceUserIds(announcement);
  const payload = {
    id: announcement.id,
    message: announcement.message,
    attachment: getAnnouncementAttachment(announcement),
    createdByName: req.user.name,
    createdAt: announcement.created_at
  };
  // Avisa ao vivo quem ja estiver logado agora (quem nao estiver, ve o recado
  // pendente assim que abrir o app, via GET /api/recados/pending).
  audienceIds.forEach((uid) => io.to('user_' + uid).emit('new_recado', payload));

  res.json({ announcement: { ...payload, audienceType, turmaId: resolvedTurmaId, audienceCount: audienceIds.length } });
});

// Recados pendentes (ainda sem ciencia) do usuario logado, do mais antigo
// pro mais novo (pra ele confirmar em ordem, um de cada vez).
app.get('/api/recados/pending', requireAuth, (req, res) => {
  const candidates = db.prepare(`
    SELECT * FROM announcements
    WHERE canceled_at IS NULL AND created_by != ?
      AND (audience_type = 'all' OR turma_id IN (SELECT turma_id FROM turma_members WHERE user_id = ?))
    ORDER BY created_at ASC
  `).all(req.user.id, req.user.id);
  const ackedIds = new Set(
    db.prepare('SELECT announcement_id FROM announcement_acks WHERE user_id = ?').all(req.user.id).map(r => r.announcement_id)
  );
  const pending = candidates.filter(a => !ackedIds.has(a.id)).map((a) => {
    const author = db.prepare('SELECT name FROM users WHERE id = ?').get(a.created_by);
    return {
      id: a.id, message: a.message, attachment: getAnnouncementAttachment(a),
      createdByName: author ? author.name : '', createdAt: a.created_at
    };
  });
  res.json({ pending });
});

// Serve o anexo do recado (imagem ou PDF), sempre "inline", so para quem faz
// parte da audiencia dele, quem criou, ou a Direcao/Gestor.
app.get('/api/recados/:id/attachment', requireAuth, (req, res) => {
  const announcement = db.prepare('SELECT * FROM announcements WHERE id = ?').get(req.params.id);
  if (!announcement || !announcement.attachment_filename) return res.status(404).end();
  const canView = announcement.created_by === req.user.id
    || RECADO_CREATE_ROLES.includes(req.user.role)
    || req.user.role === 'gestor'
    || getAnnouncementAudienceUserIds(announcement).includes(req.user.id);
  if (!canView) return res.status(403).end();
  const filePath = path.join(UPLOAD_DIR, announcement.attachment_filename);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.setHeader('Content-Type', announcement.attachment_mime);
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  fs.createReadStream(filePath).pipe(res);
});

// Da ciencia num recado - avisa quem criou (se estiver online) pra
// atualizar a lista de confirmacoes ao vivo.
app.post('/api/recados/:id/ack', requireAuth, (req, res) => {
  const announcement = db.prepare('SELECT * FROM announcements WHERE id = ?').get(req.params.id);
  if (!announcement) return res.status(404).json({ error: 'Recado nao encontrado' });
  db.prepare('INSERT OR IGNORE INTO announcement_acks (announcement_id, user_id) VALUES (?, ?)').run(announcement.id, req.user.id);
  io.to('user_' + announcement.created_by).emit('recado_ack_update', {
    announcementId: announcement.id, userId: req.user.id, userName: req.user.name
  });
  res.json({ ok: true });
});

// Lista de quem precisa confirmar e quem ja confirmou - so pra quem criou o
// recado ou pra Direcao/Gestor.
app.get('/api/recados/:id/acks', requireAuth, (req, res) => {
  const announcement = db.prepare('SELECT * FROM announcements WHERE id = ?').get(req.params.id);
  if (!announcement) return res.status(404).json({ error: 'Recado nao encontrado' });
  if (announcement.created_by !== req.user.id && !AUDIT_DM_ROLES.includes(req.user.role) && req.user.role !== 'gestor') {
    return res.status(403).json({ error: 'Sem permissao para ver as confirmacoes deste recado' });
  }
  res.json(getAnnouncementAcksPayload(announcement));
});

// Historico de recados criados (tela de gestao da Direcao) com o resumo de
// quantas pessoas ja confirmaram cada um.
app.get('/api/recados', requireAuth, requireRole(...RECADO_CREATE_ROLES), (req, res) => {
  const rows = db.prepare('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 50').all();
  const announcements = rows.map((a) => {
    const author = db.prepare('SELECT name FROM users WHERE id = ?').get(a.created_by);
    const acks = getAnnouncementAcksPayload(a);
    let turmaName = null;
    if (a.turma_id) {
      const t = db.prepare('SELECT name FROM turmas WHERE id = ?').get(a.turma_id);
      turmaName = t ? t.name : null;
    }
    return {
      id: a.id, message: a.message, attachment: getAnnouncementAttachment(a),
      createdByName: author ? author.name : '', createdAt: a.created_at,
      audienceType: a.audience_type, turmaName, canceled: !!a.canceled_at,
      ackedCount: acks.ackedCount, total: acks.total,
      canCancel: a.created_by === req.user.id || req.user.role === 'gestor'
    };
  });
  res.json({ announcements });
});

// Cancela um recado (some para quem ainda nao viu; quem ja confirmou nao muda nada).
// Tambem apaga o arquivo anexado do disco, se tiver, pra nao ficar ocupando espaco a toa.
app.delete('/api/recados/:id', requireAuth, (req, res) => {
  const announcement = db.prepare('SELECT * FROM announcements WHERE id = ?').get(req.params.id);
  if (!announcement) return res.status(404).json({ error: 'Recado nao encontrado' });
  if (announcement.created_by !== req.user.id && req.user.role !== 'gestor') {
    return res.status(403).json({ error: 'Sem permissao para cancelar este recado' });
  }
  db.prepare('UPDATE announcements SET canceled_at = CURRENT_TIMESTAMP WHERE id = ?').run(announcement.id);
  if (announcement.attachment_filename) {
    fs.unlink(path.join(UPLOAD_DIR, announcement.attachment_filename), () => {});
  }
  const audienceIds = getAnnouncementAudienceUserIds(announcement);
  audienceIds.forEach((uid) => io.to('user_' + uid).emit('recado_canceled', { announcementId: announcement.id }));
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

// Editar um item ja existente (corrigir data/refeicao/descricao). Restrito a
// um grupo especifico que "administra" o cardapio, independente de quem
// criou o item originalmente (Gestor sempre passa via requireRole).
app.put('/api/cardapio/:id', requireAuth, requireRole(...CARDAPIO_EDIT_ROLES), (req, res) => {
  const item = db.prepare('SELECT * FROM cardapio WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Nao encontrado' });
  const { date, mealType, description } = req.body;
  if (!date || !mealType || !description || !description.trim()) {
    return res.status(400).json({ error: 'Preencha data, refeicao e descricao' });
  }
  db.prepare('UPDATE cardapio SET date = ?, meal_type = ?, description = ? WHERE id = ?')
    .run(date, mealType, description.trim(), item.id);
  const row = db.prepare(`
    SELECT c.*, u.name as author_name FROM cardapio c JOIN users u ON u.id = c.created_by WHERE c.id = ?
  `).get(item.id);
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
// Calendario escolar (feriados/fins de semana sao calculados no navegador;
// aqui so ficam os eventos que a creche cadastra, tipo reuniao de pais)
// ---------------------------------------------------------------------------

// Todo mundo logado pode ver. Filtra por mes (?month=YYYY-MM) ou devolve tudo.
app.get('/api/calendario', requireAuth, (req, res) => {
  const month = req.query.month;
  const rows = month
    ? db.prepare(`
        SELECT e.*, u.name as author_name FROM calendar_events e
        JOIN users u ON u.id = e.created_by
        WHERE e.date LIKE ? ORDER BY e.date ASC
      `).all(month + '%')
    : db.prepare(`
        SELECT e.*, u.name as author_name FROM calendar_events e
        JOIN users u ON u.id = e.created_by
        ORDER BY e.date ASC
      `).all();
  res.json({
    events: rows.map(e => ({
      id: e.id, date: e.date, title: e.title, description: e.description, authorName: e.author_name
    }))
  });
});

app.post('/api/calendario', requireAuth, requireRole(...CALENDARIO_EDIT_ROLES), (req, res) => {
  const { date, title, description } = req.body;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Data invalida' });
  }
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Informe um titulo para o evento' });
  }
  const info = db.prepare(
    'INSERT INTO calendar_events (date, title, description, created_by) VALUES (?, ?, ?, ?)'
  ).run(date, title.trim(), (description || '').trim() || null, req.user.id);
  const row = db.prepare(`
    SELECT e.*, u.name as author_name FROM calendar_events e JOIN users u ON u.id = e.created_by WHERE e.id = ?
  `).get(info.lastInsertRowid);
  res.json({ event: { id: row.id, date: row.date, title: row.title, description: row.description, authorName: row.author_name } });
});

app.put('/api/calendario/:id', requireAuth, requireRole(...CALENDARIO_EDIT_ROLES), (req, res) => {
  const item = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Evento nao encontrado' });
  const { date, title, description } = req.body;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Data invalida' });
  }
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Informe um titulo para o evento' });
  }
  db.prepare('UPDATE calendar_events SET date = ?, title = ?, description = ? WHERE id = ?')
    .run(date, title.trim(), (description || '').trim() || null, item.id);
  res.json({ ok: true });
});

app.delete('/api/calendario/:id', requireAuth, requireRole(...CALENDARIO_EDIT_ROLES), (req, res) => {
  const item = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Evento nao encontrado' });
  db.prepare('DELETE FROM calendar_events WHERE id = ?').run(item.id);
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

  // Sala pessoal (sempre conectada, independente de qual chat esta aberto) -
  // usada so pra avisar "tem mensagem nova" e atualizar os numerinhos de nao
  // lidas nas listas, sem precisar que a pessoa esteja com aquele chat aberto.
  socket.join('user_' + sess.userId);

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

// ---------------------------------------------------------------------------
// Limpeza automatica: mensagens de turma somem definitivamente apos 5 dias
// (texto, fotos/PDFs anexados e enquetes junto) - e o que mantem o app leve
// e sem ocupar espaco demais no disco do Render.
// ---------------------------------------------------------------------------
const TURMA_MESSAGE_LIFETIME_DAYS = 5;

function purgeOldTurmaMessages() {
  try {
    const old = db.prepare(`
      SELECT id, turma_id, attachment_id, poll_id FROM messages
      WHERE turma_id IS NOT NULL AND created_at < datetime('now', '-${TURMA_MESSAGE_LIFETIME_DAYS} days')
    `).all();
    if (!old.length) return;

    const runPurge = db.transaction(() => {
      old.forEach((m) => {
        if (m.attachment_id) deleteAttachmentById(m.attachment_id);
        if (m.poll_id) {
          db.prepare('DELETE FROM poll_votes WHERE poll_id = ?').run(m.poll_id);
          db.prepare('DELETE FROM poll_options WHERE poll_id = ?').run(m.poll_id);
          db.prepare('DELETE FROM polls WHERE id = ?').run(m.poll_id);
        }
        db.prepare('DELETE FROM message_reactions WHERE message_id = ?').run(m.id);
        db.prepare('DELETE FROM messages WHERE id = ?').run(m.id);
      });
    });
    runPurge();

    // Avisa quem estiver com a turma aberta na tela agora pra sumir com a
    // mensagem ao vivo, sem precisar recarregar a pagina.
    old.forEach((m) => {
      io.to('turma_' + m.turma_id).emit('message_purged', { turmaId: m.turma_id, id: m.id });
    });
    console.log(`Limpeza automatica: ${old.length} mensagem(ns) de turma com mais de ${TURMA_MESSAGE_LIFETIME_DAYS} dias removida(s).`);
  } catch (err) {
    console.error('Erro na limpeza automatica de mensagens antigas:', err);
  }
}

// Roda uma vez pouco depois de subir o servidor, e depois a cada hora.
setTimeout(purgeOldTurmaMessages, 60 * 1000);
setInterval(purgeOldTurmaMessages, 60 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`CEI Ângela Amin app rodando em http://localhost:${PORT}`);
  console.log(`Codigo de acesso da equipe (STAFF_CODE): ${STAFF_CODE}`);
});
