/* global io, pdfjsLib */
(function () {
  'use strict';

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  const STAFF_ROLES = ['estagiaria', 'professora_regente', 'professora_auxiliar', 'cozinha', 'diretora', 'coordenadora_pedagogica', 'secretaria', 'gestor'];
  const CARDAPIO_ROLES = ['cozinha', 'professora_regente', 'professora_auxiliar', 'estagiaria', 'diretora', 'coordenadora_pedagogica', 'gestor'];
  const CARDAPIO_ADMIN_ROLES = ['diretora', 'coordenadora_pedagogica', 'gestor'];
  const CARDAPIO_EDIT_ROLES = ['cozinha', 'secretaria', 'coordenadora_pedagogica', 'gestor'];
  const FIN_MANAGE_ROLES = ['diretora', 'gestor', 'secretaria'];
  const FIN_DELETE_ROLES = ['diretora', 'gestor'];
  const DIRECAO_ROLES = ['diretora', 'coordenadora_pedagogica', 'secretaria', 'gestor'];
  const CALENDARIO_EDIT_ROLES = ['coordenadora_pedagogica', 'gestor'];
  const FORWARD_TARGET_ROLES = ['professora_regente', 'secretaria', 'coordenadora_pedagogica', 'diretora', 'gestor'];
  const POLL_CREATE_ROLES = ['professora_regente', 'professora_auxiliar', 'estagiaria', 'diretora', 'coordenadora_pedagogica', 'secretaria', 'gestor'];
  const TURMA_MANAGE_ROLES = DIRECAO_ROLES; // criar, editar (renomear) ou excluir turma
  const AUDIT_DM_ROLES = DIRECAO_ROLES; // consultar qualquer conversa privada (auditoria)
  const RECADO_CREATE_ROLES = DIRECAO_ROLES; // criar recado com ciencia obrigatoria

  const NAV_VIEWS = ['turmas', 'mensagens', 'cardapio', 'financeiro', 'calendario', 'usuarios', 'auditoria', 'recados'];

  const state = {
    user: null,
    turmas: [],
    conversations: [],
    chat: null, // { type: 'turma'|'conversation', id, name, roleBadgeHtml }
    socket: null,
    inviteCode: null,
    inviteTurmaName: null,
    calMonth: new Date(), // mes atualmente exibido no calendario (dia nao importa)
    replyingTo: null, // { id, authorName, snippet } - mensagem da turma que estou respondendo
    myPollVotes: {}, // pollId -> optionId que eu escolhi (cache local pra nao perder o "selecionado" em updates ao vivo)
    recadoQueue: [], // recados pendentes de ciencia, mostrados um de cada vez
    auditoriaConversations: []
  };

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  async function api(url, options) {
    const opts = Object.assign({ headers: {} }, options || {});
    if (opts.body && !(opts.body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, opts);
    let data = {};
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) throw new Error(data.error || 'Erro inesperado');
    return data;
  }

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function fmtBRL(v) {
    return (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function fmtDateTime(iso) {
    const d = new Date(iso.replace(' ', 'T') + 'Z');
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function todayStr() {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  }

  function roleBadge(role, label) {
    return `<span class="role-badge role-${role}">${label}</span>`;
  }

  // Retorna a foto de perfil (se tiver) ou um circulo com a inicial do nome
  function avatarHtml(user, sizeClass) {
    const cls = sizeClass ? ` ${sizeClass}` : '';
    if (user && user.avatarUrl) {
      return `<img class="avatar-img${cls}" src="${user.avatarUrl}" alt="" />`;
    }
    const letter = user && user.name ? user.name.trim().charAt(0).toUpperCase() : '?';
    return `<div class="avatar-fallback${cls}">${escapeHtml(letter)}</div>`;
  }

  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ------------------------------------------------------------------
  // Modal / Viewer
  // ------------------------------------------------------------------
  function openModal(innerHtml) {
    closeModal();
    const backdrop = el(`<div class="modal-backdrop"><div class="modal">${innerHtml}</div></div>`);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
    document.getElementById('modal-root').appendChild(backdrop);
    return backdrop;
  }
  function closeModal() {
    document.getElementById('modal-root').innerHTML = '';
  }

  function openViewer(innerHtml) {
    closeViewer();
    const v = el(`<div class="viewer-backdrop">
      <div class="viewer-topbar"><button id="viewer-close">Fechar ✕</button></div>
      <div class="viewer-body">${innerHtml}</div>
      <div class="viewer-note">Conteudo apenas para visualizacao dentro do aplicativo.</div>
    </div>`);
    v.addEventListener('contextmenu', (e) => e.preventDefault());
    v.querySelector('#viewer-close').addEventListener('click', closeViewer);
    document.getElementById('viewer-root').appendChild(v);
  }
  function closeViewer() {
    document.getElementById('viewer-root').innerHTML = '';
  }

  function openImageViewer(url) {
    openViewer(`<img src="${url}" oncontextmenu="return false" draggable="false" />`);
  }

  async function openPdfViewer(url) {
    openViewer(`<div id="pdf-pages" style="display:flex;flex-direction:column;gap:14px;align-items:center;"></div>`);
    const container = document.getElementById('pdf-pages');
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      const buf = await res.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 1.3 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.oncontextmenu = () => false;
        container.appendChild(canvas);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      }
    } catch (err) {
      container.innerHTML = '<p style="color:#fff">Nao foi possivel abrir o PDF.</p>';
    }
  }

  // ------------------------------------------------------------------
  // Auth screen
  // ------------------------------------------------------------------
  const authScreen = document.getElementById('auth-screen');
  const appScreen = document.getElementById('app-screen');
  const tabLogin = document.getElementById('tab-login');
  const tabRegister = document.getElementById('tab-register');
  const formLogin = document.getElementById('form-login');
  const formRegister = document.getElementById('form-register');

  tabLogin.addEventListener('click', () => switchAuthTab('login'));
  tabRegister.addEventListener('click', () => switchAuthTab('register'));

  function switchAuthTab(which) {
    tabLogin.classList.toggle('active', which === 'login');
    tabRegister.classList.toggle('active', which === 'register');
    formLogin.classList.toggle('hidden', which !== 'login');
    formRegister.classList.toggle('hidden', which !== 'register');
  }

  const regRole = document.getElementById('reg-role');
  regRole.addEventListener('change', updateRegisterFieldsVisibility);
  function updateRegisterFieldsVisibility() {
    const role = regRole.value;
    document.getElementById('reg-staffcode-field').classList.toggle('hidden', role === 'pai');
    document.getElementById('reg-childname-field').classList.toggle('hidden', role !== 'pai');
  }
  updateRegisterFieldsVisibility();

  document.getElementById('btn-forgot-password').addEventListener('click', () => {
    openModal(`
      <h3>Esqueceu sua senha?</h3>
      <p style="font-size:14px;color:#444;line-height:1.5">
        Por enquanto a redefinicao nao e automatica. Peca para a <b>Diretora</b>,
        <b>Coordenadora Pedagogica</b>, <b>Secretaria</b> ou o <b>Gestor</b> da creche
        redefinir sua senha para voce: eles conseguem fazer isso dentro do app,
        na aba <b>"Usuarios"</b>, e depois te avisam a senha nova.
      </p>
      <div class="modal-actions"><button class="btn" id="close-forgot-pw">Entendi</button></div>
    `);
    document.getElementById('close-forgot-pw').addEventListener('click', closeModal);
  });

  formLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('login-error');
    errBox.textContent = '';
    try {
      const data = await api('/api/login', {
        method: 'POST',
        body: {
          phone: document.getElementById('login-phone').value,
          password: document.getElementById('login-password').value
        }
      });
      await onAuthSuccess(data.user);
    } catch (err) {
      errBox.textContent = err.message;
    }
  });

  formRegister.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('register-error');
    errBox.textContent = '';
    try {
      const data = await api('/api/register', {
        method: 'POST',
        body: {
          name: document.getElementById('reg-name').value,
          phone: document.getElementById('reg-phone').value,
          password: document.getElementById('reg-password').value,
          role: regRole.value,
          staffCode: document.getElementById('reg-staffcode').value
        }
      });
      await onAuthSuccess(data.user, document.getElementById('reg-childname').value);
    } catch (err) {
      errBox.textContent = err.message;
    }
  });

  async function onAuthSuccess(user, childNameForInvite) {
    state.user = user;
    state.prefillChildName = childNameForInvite || null;
    startApp();
  }

  document.getElementById('btn-logout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    location.href = '/';
  });

  // ------------------------------------------------------------------
  // Perfil / foto de perfil
  // ------------------------------------------------------------------
  function updateTopbarAvatar() {
    const img = document.getElementById('user-avatar-img');
    const fallback = document.getElementById('user-avatar-fallback');
    if (state.user.avatarUrl) {
      img.src = state.user.avatarUrl;
      img.classList.remove('hidden');
      fallback.classList.add('hidden');
    } else {
      img.classList.add('hidden');
      fallback.classList.remove('hidden');
      fallback.textContent = state.user.name ? state.user.name.trim().charAt(0).toUpperCase() : '?';
    }
  }

  document.getElementById('btn-profile').addEventListener('click', () => {
    const modal = openModal(`
      <h3>Meu perfil</h3>
      <div class="avatar-upload-wrap">
        ${avatarHtml(state.user)}
        <div>
          <input type="file" id="avatar-input" accept="image/png,image/jpeg,image/webp" class="hidden" />
          <button class="btn secondary" id="btn-change-avatar">Trocar foto</button>
        </div>
      </div>
      <p style="font-size:13px;color:#666;text-align:center">
        <b>${escapeHtml(state.user.name)}</b><br/>
        ${roleBadge(state.user.role, state.user.roleLabel)}<br/>
        Telefone: ${escapeHtml(state.user.phone || '')}
      </p>
      <div class="error-msg" id="avatar-error"></div>
      <div class="modal-actions"><button class="btn" id="close-profile">Fechar</button></div>
    `);
    document.getElementById('close-profile').addEventListener('click', closeModal);
    const avatarInput = document.getElementById('avatar-input');
    document.getElementById('btn-change-avatar').addEventListener('click', () => avatarInput.click());
    avatarInput.addEventListener('change', async () => {
      const file = avatarInput.files[0];
      if (!file) return;
      try {
        const fd = new FormData();
        fd.append('avatar', file);
        const data = await api('/api/me/avatar', { method: 'POST', body: fd });
        state.user.avatarUrl = data.avatarUrl;
        updateTopbarAvatar();
        closeModal();
      } catch (err) {
        document.getElementById('avatar-error').textContent = err.message;
      }
    });
  });

  // ------------------------------------------------------------------
  // Boot / invite detection
  // ------------------------------------------------------------------
  async function boot() {
    const params = new URLSearchParams(location.search);
    const invite = params.get('invite');
    if (invite) {
      state.inviteCode = invite;
      try {
        const data = await api('/api/turmas/invite/' + invite);
        state.inviteTurmaName = data.turma.name;
        const banner = document.getElementById('invite-banner');
        banner.textContent = `Voce foi convidado(a) para a turma "${data.turma.name}". Entre ou cadastre-se como responsavel para participar.`;
        banner.classList.remove('hidden');
        document.getElementById('join-hint').textContent = 'Apos entrar/cadastrar, voce sera adicionado(a) automaticamente a turma.';
        regRole.value = 'pai';
        updateRegisterFieldsVisibility();
        switchAuthTab('register');
      } catch (err) {
        document.getElementById('invite-banner').textContent = 'Este link de convite nao e valido.';
        document.getElementById('invite-banner').classList.remove('hidden');
      }
    }

    try {
      const data = await api('/api/me');
      state.user = data.user;
      startApp();
    } catch (err) {
      authScreen.classList.remove('hidden');
      appScreen.classList.add('hidden');
    }
  }

  // ------------------------------------------------------------------
  // App shell
  // ------------------------------------------------------------------
  async function startApp() {
    authScreen.classList.add('hidden');
    appScreen.classList.remove('hidden');
    document.getElementById('user-name').textContent = state.user.name;
    const badge = document.getElementById('user-role-badge');
    badge.textContent = state.user.roleLabel;
    badge.className = 'role-badge role-' + state.user.role;
    updateTopbarAvatar();
    document.getElementById('btn-new-turma').classList.toggle('hidden', !TURMA_MANAGE_ROLES.includes(state.user.role));
    document.getElementById('btn-new-meal').classList.toggle('hidden', !CARDAPIO_ROLES.includes(state.user.role));
    document.getElementById('btn-new-lancamento').classList.toggle('hidden', !FIN_MANAGE_ROLES.includes(state.user.role));
    document.getElementById('btn-new-evento').classList.toggle('hidden', !CALENDARIO_EDIT_ROLES.includes(state.user.role));
    document.getElementById('nav-usuarios').classList.toggle('hidden', !DIRECAO_ROLES.includes(state.user.role));
    document.getElementById('nav-auditoria').classList.toggle('hidden', !AUDIT_DM_ROLES.includes(state.user.role));
    document.getElementById('nav-recados').classList.toggle('hidden', !RECADO_CREATE_ROLES.includes(state.user.role));

    connectSocket();
    setupNav();
    setupPushNotifications();
    document.getElementById('cardapio-date').value = todayStr();
    showView('turmas');
    await handlePendingInvite();
    await loadTurmas();
    await openDeepLinkFromUrl(location.href);
    checkPendingRecados();

    // limpa o parametro ?invite=/?openTurma=/?openConversation= da URL para
    // nao repetir o fluxo em um refresh
    if (history.replaceState) {
      history.replaceState({}, '', location.pathname);
    }
  }

  // Abre a turma ou conversa certa a partir de um link com ?openTurma=ID ou
  // ?openConversation=ID - usado ao clicar numa notificacao push.
  async function openDeepLinkFromUrl(urlStr) {
    let params;
    try { params = new URL(urlStr, location.origin).searchParams; } catch (e) { return; }
    const openTurmaId = params.get('openTurma');
    const openConversationId = params.get('openConversation');
    if (openTurmaId) {
      let turma = state.turmas.find(t => String(t.id) === String(openTurmaId));
      if (!turma) { await loadTurmas(); turma = state.turmas.find(t => String(t.id) === String(openTurmaId)); }
      if (turma) openChat(turma);
    } else if (openConversationId) {
      await loadConversations();
      const conv = state.conversations.find(c => String(c.id) === String(openConversationId));
      if (conv) openConversation(conv);
    }
  }

  async function handlePendingInvite() {
    if (!state.inviteCode) return;
    try {
      const data = await api('/api/turmas');
      const already = data.turmas.some(t => t.invite_code === state.inviteCode);
      if (already) { state.inviteCode = null; return; }
    } catch (e) { /* ignore, tenta entrar mesmo assim */ }

    if (state.user.role === 'pai') {
      if (state.prefillChildName && state.prefillChildName.trim()) {
        try {
          await api('/api/turmas/join', { method: 'POST', body: { code: state.inviteCode, childName: state.prefillChildName.trim() } });
        } catch (err) {
          alert('Nao foi possivel entrar na turma: ' + err.message);
        }
        state.inviteCode = null;
        state.prefillChildName = null;
      } else {
        await promptChildNameAndJoin();
      }
    } else {
      try {
        await api('/api/turmas/join', { method: 'POST', body: { code: state.inviteCode, childName: '' } });
      } catch (err) { /* usuario da equipe pode nao precisar/conseguir entrar */ }
      state.inviteCode = null;
    }
  }

  function promptChildNameAndJoin() {
    return new Promise((resolve) => {
      openModal(`
        <h3>Nome da crianca</h3>
        <p style="font-size:13px;color:#666">Para entrar na turma${state.inviteTurmaName ? ' "' + escapeHtml(state.inviteTurmaName) + '"' : ''}, informe o nome da crianca que voce representa.</p>
        <div class="field"><input id="join-child-name" placeholder="Nome da crianca" /></div>
        <div class="error-msg" id="join-child-error"></div>
        <div class="modal-actions"><button class="btn" id="confirm-join-child">Entrar na turma</button></div>
      `);
      document.getElementById('confirm-join-child').addEventListener('click', async () => {
        const name = document.getElementById('join-child-name').value.trim();
        if (!name) { document.getElementById('join-child-error').textContent = 'Informe o nome da crianca'; return; }
        try {
          await api('/api/turmas/join', { method: 'POST', body: { code: state.inviteCode, childName: name } });
          state.inviteCode = null;
          closeModal();
          loadTurmas();
          resolve();
        } catch (err) {
          document.getElementById('join-child-error').textContent = err.message;
        }
      });
    });
  }

  function connectSocket() {
    state.socket = io();
    state.socket.on('new_message', (msg) => {
      if (state.chat && state.chat.type === 'turma' && msg.turmaId === state.chat.id) {
        appendMessage(msg);
        scrollChatToBottom();
        markTurmaAsRead(msg.turmaId); // ja esta vendo a mensagem chegar ao vivo
      }
    });
    state.socket.on('message_deleted', (info) => {
      if (state.chat && state.chat.type === 'turma' && info.turmaId === state.chat.id) {
        markMessageDeleted(info.id, info.deletedByName);
      }
    });
    state.socket.on('new_dm_message', (msg) => {
      if (state.chat && state.chat.type === 'conversation' && msg.conversationId === state.chat.id) {
        appendMessage(msg);
        scrollChatToBottom();
        markConversationAsRead(msg.conversationId);
      }
    });
    state.socket.on('dm_message_deleted', (info) => {
      if (state.chat && state.chat.type === 'conversation' && info.conversationId === state.chat.id) {
        markMessageDeleted(info.id, null);
      }
    });
    // Numerinho de nao lidas mudou em alguma turma/conversa que nao esta aberta agora
    state.socket.on('unread_bump', ({ kind }) => {
      if (kind === 'turma') loadTurmas().catch(() => {});
      else if (kind === 'conversation') loadConversations().catch(() => {});
    });
    // Alguem leu mensagens da turma que esta aberta na minha tela agora - atualiza "visto por"
    state.socket.on('turma_read_update', (info) => {
      if (state.chat && state.chat.type === 'turma' && info.turmaId === state.chat.id) {
        applyTurmaReadUpdate(info);
      }
    });
    // A outra pessoa da conversa aberta leu as minhas mensagens - atualiza "Visto"
    state.socket.on('conversation_read_update', (info) => {
      if (state.chat && state.chat.type === 'conversation' && info.conversationId === state.chat.id) {
        applyConversationReadUpdate(info);
      }
    });
    // Alguem votou (ou trocou o voto) numa enquete da turma aberta - atualiza ao vivo
    state.socket.on('poll_vote_update', (info) => {
      applyPollVoteUpdate(info);
    });
    // Alguem reagiu (ou removeu a reacao) numa mensagem da turma aberta
    state.socket.on('message_reaction_update', (info) => {
      applyReactionUpdate(info);
    });
    // Mensagem de turma completou 5 dias e foi apagada de vez (limpeza
    // automatica) - some da tela sem deixar "mensagem removida", pois nem
    // existe mais no banco.
    state.socket.on('message_purged', (info) => {
      if (state.chat && state.chat.type === 'turma' && info.turmaId === state.chat.id) {
        const wrap = document.querySelector(`#chat-messages [data-msg-id="${info.id}"]`);
        if (wrap) wrap.remove();
      }
    });
    // Chegou um recado novo enquanto eu ja estava com o app aberto - entra na fila.
    state.socket.on('new_recado', (r) => {
      if (!state.recadoQueue.some(q => q.id === r.id)) {
        state.recadoQueue.push(r);
        showNextRecado();
      }
    });
    // Alguem deu ciencia num recado que eu criei - atualiza a lista se estiver aberta.
    state.socket.on('recado_ack_update', () => {
      const modal = document.querySelector('#modal-root .modal-backdrop[data-recado-id]');
      if (modal) openRecadoAcksModal(Number(modal.dataset.recadoId));
      if (document.getElementById('view-recados') && !document.getElementById('view-recados').classList.contains('hidden')) {
        loadRecadosScreen();
      }
    });
    // Um recado foi cancelado antes de eu dar ciencia - tira da fila.
    state.socket.on('recado_canceled', ({ announcementId }) => {
      state.recadoQueue = state.recadoQueue.filter(q => q.id !== announcementId);
      showNextRecado();
    });
    // Uma turma foi renomeada - atualiza o titulo se essa turma estiver aberta agora
    state.socket.on('turma_renamed', (info) => {
      if (state.chat && state.chat.type === 'turma' && state.chat.id === info.turmaId) {
        state.chat.name = info.name;
        document.getElementById('chat-turma-name').innerHTML = escapeHtml(info.name);
      }
      loadTurmas().catch(() => {});
    });
    // Uma turma foi excluida - se for a que esta aberta, volta pra lista
    state.socket.on('turma_deleted', (info) => {
      if (state.chat && state.chat.type === 'turma' && state.chat.id === info.turmaId) {
        alert('Esta turma foi excluida.');
        showView('turmas');
      }
      loadTurmas().catch(() => {});
    });
  }

  function applyTurmaReadUpdate({ userId, userName }) {
    if (userId === state.user.id) return; // nao precisa mostrar "visto por mim mesmo"
    document.querySelectorAll('#chat-messages .msg.mine .msg-seen').forEach((seenEl) => {
      const names = seenEl.dataset.names ? seenEl.dataset.names.split('|') : [];
      if (!names.includes(userName)) {
        names.push(userName);
        seenEl.dataset.names = names.join('|');
        seenEl.textContent = 'Visto por ' + names.join(', ');
      }
    });
  }

  function applyConversationReadUpdate({ userId }) {
    if (userId === state.user.id) return;
    document.querySelectorAll('#chat-messages .msg.mine .msg-seen').forEach((seenEl) => {
      seenEl.textContent = 'Visto';
    });
  }

  function setupNav() {
    document.querySelectorAll('.nav-tabs button').forEach(btn => {
      btn.addEventListener('click', () => showView(btn.dataset.view));
    });
  }

  function showView(name) {
    leaveChatSocketIfNeeded();
    document.querySelectorAll('.nav-tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    NAV_VIEWS.forEach(v => {
      document.getElementById('view-' + v).classList.toggle('hidden', v !== name);
    });
    document.getElementById('view-chat').classList.add('hidden');
    document.querySelector('.nav-tabs').classList.remove('hidden');
    if (name === 'turmas') loadTurmas();
    if (name === 'mensagens') loadConversations();
    if (name === 'cardapio') loadCardapio();
    if (name === 'financeiro') loadFinanceiro();
    if (name === 'calendario') loadCalendario();
    if (name === 'usuarios') loadUsuarios();
    if (name === 'auditoria') loadAuditoria();
    if (name === 'recados') loadRecadosScreen();
  }

  function leaveChatSocketIfNeeded() {
    if (state.chat) {
      if (state.chat.type === 'turma') state.socket.emit('leave_turma', state.chat.id);
      else state.socket.emit('leave_conversation', state.chat.id);
      state.chat = null;
    }
  }

  // ------------------------------------------------------------------
  // Turmas
  // ------------------------------------------------------------------
  async function loadTurmas() {
    const data = await api('/api/turmas');
    state.turmas = data.turmas;
    const grid = document.getElementById('turma-grid');
    grid.innerHTML = '';
    if (!data.turmas.length) {
      grid.innerHTML = `<div class="empty-state">Nenhuma turma ainda.${TURMA_MANAGE_ROLES.includes(state.user.role) ? ' Clique em "Criar turma" para comecar.' : ' Peca a professora o link de convite da turma.'}</div>`;
      return;
    }
    const canManageTurma = TURMA_MANAGE_ROLES.includes(state.user.role);
    data.turmas.forEach(t => {
      const card = el(`<div class="turma-card">
        ${canManageTurma ? `
          <div class="turma-card-admin-actions">
            <button class="icon-btn-sm btn-edit-turma" title="Renomear turma">✏️</button>
            <button class="icon-btn-sm btn-delete-turma" title="Excluir turma">🗑</button>
          </div>` : ''}
        <h3>${escapeHtml(t.name)} ${t.unread_count > 0 ? `<span class="unread-badge">${t.unread_count}</span>` : ''}</h3>
        <p>${t.member_count} participante(s)</p>
      </div>`);
      card.addEventListener('click', () => openChat(t));
      const editBtn = card.querySelector('.btn-edit-turma');
      if (editBtn) editBtn.addEventListener('click', (e) => { e.stopPropagation(); openEditTurmaModal(t); });
      const delBtn = card.querySelector('.btn-delete-turma');
      if (delBtn) delBtn.addEventListener('click', (e) => { e.stopPropagation(); confirmDeleteTurma(t); });
      grid.appendChild(card);
    });
  }

  function openEditTurmaModal(turma) {
    openModal(`
      <h3>Renomear turma</h3>
      <div class="field"><label>Nome da turma</label><input id="edit-turma-name" value="${escapeHtml(turma.name)}" /></div>
      <div class="error-msg" id="edit-turma-error"></div>
      <div class="modal-actions">
        <button class="btn secondary" id="cancel-edit-turma">Cancelar</button>
        <button class="btn" id="confirm-edit-turma">Salvar</button>
      </div>
    `);
    document.getElementById('cancel-edit-turma').addEventListener('click', closeModal);
    document.getElementById('confirm-edit-turma').addEventListener('click', async () => {
      const name = document.getElementById('edit-turma-name').value.trim();
      if (!name) return;
      try {
        await api(`/api/turmas/${turma.id}`, { method: 'PUT', body: { name } });
        closeModal();
        loadTurmas();
      } catch (err) {
        document.getElementById('edit-turma-error').textContent = err.message;
      }
    });
  }

  async function confirmDeleteTurma(turma) {
    const sure = confirm(
      `Excluir a turma "${turma.name}" para sempre?\n\nIsso apaga DEFINITIVAMENTE todas as mensagens, fotos/PDFs e a lista de participantes dessa turma. Nao tem como desfazer.`
    );
    if (!sure) return;
    try {
      await api(`/api/turmas/${turma.id}`, { method: 'DELETE' });
      loadTurmas();
    } catch (err) {
      alert('Erro ao excluir turma: ' + err.message);
    }
  }

  document.getElementById('btn-new-turma').addEventListener('click', () => {
    openModal(`
      <h3>Criar nova turma</h3>
      <div class="field"><label>Nome da turma</label><input id="new-turma-name" placeholder="Ex: Turma do Jardim II" /></div>
      <div class="error-msg" id="new-turma-error"></div>
      <div class="modal-actions">
        <button class="btn secondary" id="cancel-new-turma">Cancelar</button>
        <button class="btn" id="confirm-new-turma">Criar</button>
      </div>
    `);
    document.getElementById('cancel-new-turma').addEventListener('click', closeModal);
    document.getElementById('confirm-new-turma').addEventListener('click', async () => {
      const name = document.getElementById('new-turma-name').value.trim();
      if (!name) return;
      try {
        const data = await api('/api/turmas', { method: 'POST', body: { name } });
        closeModal();
        await loadTurmas();
        showInviteModal(data.turma);
      } catch (err) {
        document.getElementById('new-turma-error').textContent = err.message;
      }
    });
  });

  function showInviteModal(turma) {
    const link = location.origin + '/?invite=' + turma.invite_code;
    openModal(`
      <h3>Turma "${escapeHtml(turma.name)}" criada!</h3>
      <p style="font-size:13px;color:#666">Envie este link para os responsaveis entrarem na sala de bate-papo da turma:</p>
      <div class="invite-link-box"><span id="invite-link-text">${link}</span></div>
      <div class="modal-actions">
        <button class="btn secondary" id="copy-invite">Copiar link</button>
        <button class="btn" id="close-invite">Fechar</button>
      </div>
    `);
    document.getElementById('copy-invite').addEventListener('click', () => {
      navigator.clipboard.writeText(link).then(() => {
        document.getElementById('copy-invite').textContent = 'Copiado!';
      });
    });
    document.getElementById('close-invite').addEventListener('click', closeModal);
  }

  // ------------------------------------------------------------------
  // Chat (turma em grupo)
  // ------------------------------------------------------------------
  async function openChat(turma) {
    state.chat = { type: 'turma', id: turma.id, name: turma.name, inviteCode: turma.invite_code };
    state.replyingTo = null;
    hideReplyPreview();
    document.getElementById('view-chat').classList.remove('hidden');
    NAV_VIEWS.forEach(v => document.getElementById('view-' + v).classList.add('hidden'));
    document.querySelector('.nav-tabs').classList.add('hidden');
    document.getElementById('chat-turma-name').innerHTML = escapeHtml(turma.name);
    document.getElementById('btn-invite').classList.remove('hidden');
    document.getElementById('btn-members').classList.remove('hidden');
    document.getElementById('btn-poll').classList.toggle('hidden', !POLL_CREATE_ROLES.includes(state.user.role));
    document.getElementById('chat-input-bar').classList.remove('hidden');
    document.getElementById('audit-note').classList.add('hidden');
    document.getElementById('chat-messages').innerHTML = '';

    state.socket.emit('join_turma', turma.id);
    const data = await api(`/api/turmas/${turma.id}/messages`);
    data.messages.forEach(appendMessage);
    scrollChatToBottom();
    markTurmaAsRead(turma.id);
  }

  function markTurmaAsRead(turmaId) {
    const t = state.turmas.find(x => x.id === turmaId);
    if (t) t.unread_count = 0;
    api(`/api/turmas/${turmaId}/read`, { method: 'POST' }).catch(() => {});
  }

  document.getElementById('btn-back-turmas').addEventListener('click', () => {
    if (state.chat && state.chat.type === 'conversation') return showView('mensagens');
    if (state.chat && state.chat.type === 'audit') return showView('auditoria');
    showView('turmas');
  });

  document.getElementById('btn-invite').addEventListener('click', () => {
    if (state.chat && state.chat.type === 'turma') showInviteModal({ name: state.chat.name, invite_code: state.chat.inviteCode });
  });

  async function renderMembersModal() {
    const turmaId = state.chat.id;
    const data = await api(`/api/turmas/${turmaId}/members`);
    const rows = data.members.map(m => `
      <div class="member-row">
        ${avatarHtml(m)}
        ${roleBadge(m.role, m.roleLabel)}
        <div>
          <div class="name">${escapeHtml(m.name)}</div>
          ${m.child_name ? `<div class="child">Responsavel por: ${escapeHtml(m.child_name)}</div>` : ''}
        </div>
        <div class="spacer"></div>
        ${data.canManage && m.id !== state.user.id ? `<button class="remove-member" data-remove-user="${m.id}">remover</button>` : ''}
      </div>`).join('');
    const modal = openModal(`
      <h3>Participantes</h3>
      <div>${rows || '<p>Nenhum participante ainda.</p>'}</div>
      <div class="modal-actions">
        ${data.canManage ? '<button class="btn secondary" id="btn-add-member">+ Adicionar pessoa</button>' : ''}
        <button class="btn" id="close-members">Fechar</button>
      </div>
    `);
    document.getElementById('close-members').addEventListener('click', closeModal);
    modal.querySelectorAll('[data-remove-user]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remover esta pessoa da turma?')) return;
        try {
          await api(`/api/turmas/${turmaId}/members/${btn.dataset.removeUser}`, { method: 'DELETE' });
          renderMembersModal();
        } catch (err) {
          alert('Erro ao remover: ' + err.message);
        }
      });
    });
    const addBtn = document.getElementById('btn-add-member');
    if (addBtn) addBtn.addEventListener('click', () => openAddMemberModal(turmaId));
  }

  async function openAddMemberModal(turmaId) {
    let users = [];
    try {
      const data = await api(`/api/turmas/${turmaId}/addable-users`);
      users = data.users;
    } catch (err) {
      alert('Erro ao carregar pessoas: ' + err.message);
      return;
    }
    const rows = users.map(u => `
      <div class="member-row contact-row" data-add-user="${u.id}" data-role="${u.role}" style="cursor:pointer">
        ${roleBadge(u.role, u.roleLabel)}
        <div><div class="name">${escapeHtml(u.name)}</div></div>
      </div>`).join('');
    const modal = openModal(`
      <h3>Adicionar pessoa a turma</h3>
      <div>${rows || '<p>Nao ha ninguem disponivel para adicionar no momento.</p>'}</div>
      <div class="modal-actions"><button class="btn secondary" id="cancel-add-member">Voltar</button></div>
    `);
    document.getElementById('cancel-add-member').addEventListener('click', () => renderMembersModal());
    modal.querySelectorAll('[data-add-user]').forEach(row => {
      row.addEventListener('click', async () => {
        const userId = Number(row.dataset.addUser);
        let childName = '';
        if (row.dataset.role === 'pai') {
          childName = prompt('Nome da crianca que essa pessoa representa:') || '';
          if (!childName.trim()) return;
        }
        try {
          await api(`/api/turmas/${turmaId}/members`, { method: 'POST', body: { userId, childName } });
          await loadTurmas();
          renderMembersModal();
        } catch (err) {
          alert('Erro ao adicionar: ' + err.message);
        }
      });
    });
  }

  document.getElementById('btn-members').addEventListener('click', () => {
    if (!state.chat || state.chat.type !== 'turma') return;
    renderMembersModal();
  });

  function appendMessage(msg) {
    const mine = msg.user.id === state.user.id;
    const isTurma = state.chat && state.chat.type === 'turma';
    const wrap = el(`<div class="msg ${mine ? 'mine' : ''}" data-msg-id="${msg.id}"></div>`);
    const meta = el(`<div class="meta"></div>`);
    meta.innerHTML = `${avatarHtml(msg.user, 'small')} <b>${escapeHtml(msg.user.name)}</b> ${roleBadge(msg.user.role, msg.user.roleLabel)} <span>${fmtDateTime(msg.createdAt)}</span>`;
    if (isTurma && !msg.deleted) {
      const replyBtn = el(`<button class="msg-del" title="Responder">↩️</button>`);
      replyBtn.addEventListener('click', () => startReplyTo(msg));
      meta.appendChild(replyBtn);
      if (msg.content && FORWARD_TARGET_ROLES.includes(state.user.role)) {
        const fwdBtn = el(`<button class="msg-del" title="Encaminhar para outras turmas">↪️</button>`);
        fwdBtn.addEventListener('click', () => openForwardModal(msg));
        meta.appendChild(fwdBtn);
      }
    }
    if (msg.canDelete) {
      const delBtn = el(`<button class="msg-del" title="Apagar mensagem para todos">🗑</button>`);
      delBtn.addEventListener('click', () => deleteMessage(msg.id));
      meta.appendChild(delBtn);
    }
    // Nas conversas privadas, qualquer participante pode apagar qualquer
    // mensagem so para si mesmo (a outra pessoa continua vendo normalmente).
    if (state.chat && state.chat.type === 'conversation') {
      const hideBtn = el(`<button class="msg-del" title="Apagar somente para mim">🙈</button>`);
      hideBtn.addEventListener('click', () => hideMessageForMe(msg.id));
      meta.appendChild(hideBtn);
    }
    const bubble = el(`<div class="bubble"></div>`);
    if (msg.deleted) {
      bubble.classList.add('deleted');
      bubble.textContent = msg.deletedByName ? `Mensagem removida por ${msg.deletedByName}` : 'Mensagem removida';
    } else {
      if (msg.replyTo) {
        const quote = el(`<div class="reply-quote"></div>`);
        quote.innerHTML = `<b>${escapeHtml(msg.replyTo.authorName || '')}</b><span>${escapeHtml(msg.replyTo.snippet || '')}</span>`;
        bubble.appendChild(quote);
      }
      if (msg.poll) {
        if (msg.poll.myOptionId != null) state.myPollVotes[msg.poll.id] = msg.poll.myOptionId;
        bubble.appendChild(renderPollWidget(msg.poll));
      }
      if (msg.content) {
        const p = document.createElement('div');
        p.textContent = msg.content;
        bubble.appendChild(p);
      }
      if (msg.attachment) {
        if (msg.attachment.kind === 'imagem') {
          const img = el(`<img class="chat-thumb" src="/api/attachments/${msg.attachment.id}" oncontextmenu="return false" draggable="false" />`);
          img.addEventListener('click', () => openImageViewer(`/api/attachments/${msg.attachment.id}`));
          bubble.appendChild(img);
        } else {
          const chip = el(`<div class="pdf-chip">📄 ${escapeHtml(msg.attachment.name || 'Documento PDF')}</div>`);
          chip.addEventListener('click', () => openPdfViewer(`/api/attachments/${msg.attachment.id}`));
          bubble.appendChild(chip);
        }
      }
    }
    wrap.appendChild(meta);
    wrap.appendChild(bubble);

    // Reacoes (joinha/coracao): so faz sentido no chat da turma e em mensagens
    // que ainda existem (nao apagadas).
    if (isTurma && !msg.deleted) {
      wrap.appendChild(renderReactionsBar(msg.id, msg.reactions));
    }

    // "Visto por" / "Visto": so mostra embaixo das minhas proprias mensagens
    if (mine && !msg.deleted) {
      const seenEl = document.createElement('div');
      seenEl.className = 'msg-seen';
      if (Array.isArray(msg.readBy)) {
        seenEl.dataset.names = msg.readBy.join('|');
        seenEl.textContent = msg.readBy.length ? 'Visto por ' + msg.readBy.join(', ') : '';
      } else if (msg.seenByOther) {
        seenEl.textContent = 'Visto';
      }
      wrap.appendChild(seenEl);
    }

    document.getElementById('chat-messages').appendChild(wrap);
  }

  // ------------------------------------------------------------------
  // Responder mensagem (reply)
  // ------------------------------------------------------------------
  function startReplyTo(msg) {
    let snippet = msg.content ? msg.content : (msg.attachment ? '📎 Anexo' : (msg.poll ? '📊 Enquete: ' + msg.poll.question : ''));
    if (snippet.length > 120) snippet = snippet.slice(0, 120) + '…';
    state.replyingTo = { id: msg.id, authorName: msg.user.name, snippet };
    document.getElementById('reply-preview-name').textContent = msg.user.name;
    document.getElementById('reply-preview-snippet').textContent = snippet;
    document.getElementById('reply-preview').classList.remove('hidden');
    document.getElementById('chat-text').focus();
  }

  function hideReplyPreview() {
    const el2 = document.getElementById('reply-preview');
    if (el2) el2.classList.add('hidden');
  }

  document.getElementById('btn-cancel-reply').addEventListener('click', () => {
    state.replyingTo = null;
    hideReplyPreview();
  });

  // ------------------------------------------------------------------
  // Encaminhar mensagem da turma
  // ------------------------------------------------------------------
  async function openForwardModal(msg) {
    let targets = [];
    try {
      const data = await api(`/api/turmas/${state.chat.id}/forward-targets`);
      targets = data.targets;
    } catch (err) {
      alert('Erro ao carregar lista de turmas: ' + err.message);
      return;
    }
    const rows = targets.map(t => `
      <div class="member-row" style="cursor:pointer">
        <label style="display:flex;align-items:center;gap:10px;width:100%;cursor:pointer">
          <input type="checkbox" class="fwd-turma-check" value="${t.id}" style="width:18px;height:18px" />
          <span class="name">${escapeHtml(t.name)}</span>
        </label>
      </div>`).join('');
    const modal = openModal(`
      <h3>Encaminhar recado para outras turmas</h3>
      <p style="font-size:13px;color:#666">Escolha para quais turmas encaminhar este recado. Ele aparece no chat de cada turma selecionada, avisando de qual turma veio.</p>
      ${targets.length ? '<button type="button" class="btn ghost" id="btn-fwd-select-all" style="font-size:12px;padding:4px 10px;margin-bottom:8px">Selecionar todas</button>' : ''}
      <div id="fwd-turma-rows">${rows || '<p>Nao ha outras turmas para encaminhar no momento.</p>'}</div>
      <div class="error-msg" id="forward-error"></div>
      <div class="modal-actions">
        <button class="btn secondary" id="cancel-forward">Cancelar</button>
        ${targets.length ? '<button class="btn" id="confirm-forward">Encaminhar</button>' : ''}
      </div>
    `);
    document.getElementById('cancel-forward').addEventListener('click', closeModal);
    const selectAllBtn = document.getElementById('btn-fwd-select-all');
    if (selectAllBtn) {
      selectAllBtn.addEventListener('click', () => {
        const boxes = modal.querySelectorAll('.fwd-turma-check');
        const allChecked = Array.from(boxes).every(b => b.checked);
        boxes.forEach(b => { b.checked = !allChecked; });
        selectAllBtn.textContent = allChecked ? 'Selecionar todas' : 'Desmarcar todas';
      });
    }
    const confirmBtn = document.getElementById('confirm-forward');
    if (confirmBtn) {
      confirmBtn.addEventListener('click', async () => {
        const toTurmaIds = Array.from(modal.querySelectorAll('.fwd-turma-check:checked')).map(b => Number(b.value));
        if (!toTurmaIds.length) {
          document.getElementById('forward-error').textContent = 'Escolha pelo menos uma turma';
          return;
        }
        try {
          const data = await api(`/api/turmas/${state.chat.id}/messages/${msg.id}/forward`, { method: 'POST', body: { toTurmaIds } });
          closeModal();
          const names = (data.sent || []).map(s => s.turmaName).join(', ');
          if (names) alert('Recado encaminhado para: ' + names);
        } catch (err) {
          document.getElementById('forward-error').textContent = err.message;
        }
      });
    }
  }

  // ------------------------------------------------------------------
  // Enquetes na turma
  // ------------------------------------------------------------------
  document.getElementById('btn-poll').addEventListener('click', () => {
    if (!state.chat || state.chat.type !== 'turma') return;
    openPollModal();
  });

  function openPollModal() {
    const modal = openModal(`
      <h3>Criar enquete</h3>
      <div class="field"><label>Pergunta</label><input type="text" id="poll-question" placeholder="Ex: Qual dia da excursao?" /></div>
      <div class="field"><label>Opcoes</label>
        <div id="poll-options-wrap">
          <input type="text" class="poll-option-input" placeholder="Opcao 1" style="margin-bottom:6px" />
          <input type="text" class="poll-option-input" placeholder="Opcao 2" style="margin-bottom:6px" />
        </div>
        <button type="button" class="btn ghost" id="btn-add-poll-option" style="font-size:12px;padding:4px 10px">+ Adicionar opcao</button>
      </div>
      <div class="error-msg" id="poll-error"></div>
      <div class="modal-actions">
        <button class="btn secondary" id="cancel-poll">Cancelar</button>
        <button class="btn" id="confirm-poll">Criar enquete</button>
      </div>
    `);
    document.getElementById('btn-add-poll-option').addEventListener('click', () => {
      const wrap = document.getElementById('poll-options-wrap');
      if (wrap.querySelectorAll('.poll-option-input').length >= 8) return;
      const input = el(`<input type="text" class="poll-option-input" placeholder="Opcao ${wrap.querySelectorAll('.poll-option-input').length + 1}" style="margin-bottom:6px" />`);
      wrap.appendChild(input);
    });
    document.getElementById('cancel-poll').addEventListener('click', closeModal);
    document.getElementById('confirm-poll').addEventListener('click', async () => {
      const question = document.getElementById('poll-question').value.trim();
      const options = Array.from(document.querySelectorAll('.poll-option-input'))
        .map(i => i.value.trim())
        .filter(Boolean);
      try {
        await api(`/api/turmas/${state.chat.id}/polls`, { method: 'POST', body: { question, options } });
        closeModal();
      } catch (err) {
        document.getElementById('poll-error').textContent = err.message;
      }
    });
  }

  function renderPollWidget(poll) {
    const myOptionId = state.myPollVotes.hasOwnProperty(poll.id) ? state.myPollVotes[poll.id] : poll.myOptionId;
    const box = el(`<div class="poll-box" data-poll-id="${poll.id}"></div>`);
    const q = el(`<div class="poll-question"></div>`);
    q.textContent = '📊 ' + poll.question;
    box.appendChild(q);
    poll.options.forEach(opt => {
      const pct = poll.totalVotes ? Math.round((opt.count / poll.totalVotes) * 100) : 0;
      const optBtn = el(`<button type="button" class="poll-option${opt.id === myOptionId ? ' selected' : ''}" data-option-id="${opt.id}"></button>`);
      optBtn.innerHTML = `
        <div class="poll-option-row"><span class="poll-option-text">${escapeHtml(opt.text)}</span><span class="poll-option-count">${opt.count}</span></div>
        <div class="poll-bar"><div class="poll-bar-fill" style="width:${pct}%"></div></div>
        ${opt.voters && opt.voters.length ? `<div class="poll-voters">${opt.voters.map(escapeHtml).join(', ')}</div>` : ''}
      `;
      optBtn.addEventListener('click', () => voteInPoll(poll.id, opt.id));
      box.appendChild(optBtn);
    });
    const total = el(`<div class="poll-total"></div>`);
    total.textContent = poll.totalVotes + (poll.totalVotes === 1 ? ' voto' : ' votos');
    box.appendChild(total);
    return box;
  }

  async function voteInPoll(pollId, optionId) {
    if (!state.chat || state.chat.type !== 'turma') return;
    try {
      const data = await api(`/api/turmas/${state.chat.id}/polls/${pollId}/vote`, { method: 'POST', body: { optionId } });
      state.myPollVotes[pollId] = optionId;
      const box = document.querySelector(`.poll-box[data-poll-id="${pollId}"]`);
      if (box && data.poll) box.replaceWith(renderPollWidget(data.poll));
    } catch (err) {
      alert('Erro ao votar: ' + err.message);
    }
  }

  function applyPollVoteUpdate(data) {
    if (!state.chat || state.chat.type !== 'turma' || state.chat.id !== data.turmaId) return;
    const box = document.querySelector(`.poll-box[data-poll-id="${data.pollId}"]`);
    if (!box) return;
    const fresh = renderPollWidget(data.poll);
    box.replaceWith(fresh);
  }

  // ------------------------------------------------------------------
  // Reacoes nas mensagens da turma (joinha e coracao)
  // ------------------------------------------------------------------
  const REACTION_EMOJIS = ['👍', '❤️'];

  function renderReactionsBar(msgId, reactions) {
    const bar = el(`<div class="reactions-bar" data-msg-id="${msgId}"></div>`);
    REACTION_EMOJIS.forEach((emoji) => {
      const r = (reactions || []).find(x => x.emoji === emoji) || { emoji, count: 0, userIds: [], names: [] };
      const mine = Array.isArray(r.userIds) && r.userIds.includes(state.user.id);
      const btn = el(`<button type="button" class="reaction-btn ${mine ? 'mine' : ''}"><span>${emoji}</span>${r.count ? `<span class="reaction-count">${r.count}</span>` : ''}</button>`);
      if (r.count && r.names && r.names.length) btn.title = r.names.join(', ');
      btn.addEventListener('click', () => reactToMessage(msgId, emoji));
      bar.appendChild(btn);
    });
    return bar;
  }

  async function reactToMessage(msgId, emoji) {
    if (!state.chat || state.chat.type !== 'turma') return;
    try {
      const data = await api(`/api/turmas/${state.chat.id}/messages/${msgId}/react`, { method: 'POST', body: { emoji } });
      applyReactionUpdate({ turmaId: state.chat.id, messageId: msgId, reactions: data.reactions });
    } catch (err) {
      alert('Erro ao reagir: ' + err.message);
    }
  }

  function applyReactionUpdate(data) {
    if (!state.chat || state.chat.type !== 'turma' || state.chat.id !== data.turmaId) return;
    const oldBar = document.querySelector(`#chat-messages .reactions-bar[data-msg-id="${data.messageId}"]`);
    if (!oldBar) return;
    oldBar.replaceWith(renderReactionsBar(data.messageId, data.reactions));
  }

  function markMessageDeleted(id, deletedByName) {
    const wrap = document.querySelector(`#chat-messages [data-msg-id="${id}"]`);
    if (!wrap) return;
    const bubble = wrap.querySelector('.bubble');
    bubble.classList.add('deleted');
    bubble.textContent = deletedByName ? `Mensagem removida por ${deletedByName}` : 'Mensagem removida';
    const delBtn = wrap.querySelector('.msg-del');
    if (delBtn) delBtn.remove();
  }

  async function deleteMessage(id) {
    if (!confirm('Apagar esta mensagem para todos?')) return;
    try {
      const endpoint = state.chat.type === 'turma' ? `/api/messages/${id}` : `/api/dm-messages/${id}`;
      await api(endpoint, { method: 'DELETE' });
      markMessageDeleted(id, state.user.name);
    } catch (err) {
      alert('Erro ao apagar: ' + err.message);
    }
  }

  // Apaga so para mim (a outra pessoa da conversa continua vendo normalmente).
  async function hideMessageForMe(id) {
    if (!confirm('Apagar esta mensagem somente para voce? A outra pessoa continua vendo normalmente.')) return;
    try {
      await api(`/api/dm-messages/${id}/hide-for-me`, { method: 'POST' });
      const wrap = document.querySelector(`#chat-messages [data-msg-id="${id}"]`);
      if (wrap) wrap.remove();
    } catch (err) {
      alert('Erro ao apagar mensagem: ' + err.message);
    }
  }

  function scrollChatToBottom() {
    const box = document.getElementById('chat-messages');
    box.scrollTop = box.scrollHeight;
  }

  const chatText = document.getElementById('chat-text');
  const fileInput = document.getElementById('file-input');
  let pendingFile = null;

  document.getElementById('btn-attach').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    pendingFile = fileInput.files[0] || null;
    document.getElementById('btn-attach').textContent = pendingFile ? '✅' : '📎';
  });

  chatText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  document.getElementById('btn-send').addEventListener('click', sendMessage);

  async function sendMessage() {
    if (!state.chat) return;
    const text = chatText.value.trim();
    if (!text && !pendingFile) return;
    let attachmentId = null;
    const base = state.chat.type === 'turma' ? `/api/turmas/${state.chat.id}` : `/api/conversations/${state.chat.id}`;
    try {
      if (pendingFile) {
        const fd = new FormData();
        fd.append('file', pendingFile);
        const up = await api(`${base}/attachments`, { method: 'POST', body: fd });
        attachmentId = up.attachmentId;
      }
      const body = { content: text, attachmentId };
      if (state.chat.type === 'turma' && state.replyingTo) {
        body.replyToMessageId = state.replyingTo.id;
      }
      await api(`${base}/messages`, { method: 'POST', body });
      chatText.value = '';
      pendingFile = null;
      fileInput.value = '';
      document.getElementById('btn-attach').textContent = '📎';
      state.replyingTo = null;
      hideReplyPreview();
    } catch (err) {
      alert('Erro ao enviar: ' + err.message);
    }
  }

  // ------------------------------------------------------------------
  // Mensagens privadas (conversas 1:1)
  // ------------------------------------------------------------------
  async function loadConversations() {
    const data = await api('/api/conversations');
    state.conversations = data.conversations;
    const grid = document.getElementById('conversa-grid');
    grid.innerHTML = '';
    if (!data.conversations.length) {
      grid.innerHTML = '<div class="empty-state">Nenhuma conversa ainda. Clique em "Nova conversa" para falar com a equipe.</div>';
      return;
    }
    data.conversations.forEach(c => {
      const card = el(`<div class="turma-card conversa-card">
        <button class="btn-delete-conversa" title="Excluir conversa (so para voce)">🗑</button>
        <h3>${avatarHtml(c.other, 'small')} ${escapeHtml(c.other.name)} ${roleBadge(c.other.role, c.other.roleLabel)} ${c.unread_count > 0 ? `<span class="unread-badge">${c.unread_count}</span>` : ''}</h3>
        <p>${c.lastMessagePreview ? escapeHtml(c.lastMessagePreview) : 'Nenhuma mensagem ainda'}</p>
      </div>`);
      card.addEventListener('click', () => openConversation(c));
      card.querySelector('.btn-delete-conversa').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Excluir a conversa com ${c.other.name}? Ela some so da sua lista - ${c.other.name} continua vendo as mensagens normalmente.`)) return;
        try {
          await api(`/api/conversations/${c.id}`, { method: 'DELETE' });
          loadConversations();
        } catch (err) {
          alert('Erro ao excluir conversa: ' + err.message);
        }
      });
      grid.appendChild(card);
    });
  }

  document.getElementById('btn-new-conversa').addEventListener('click', async () => {
    let contacts = [];
    try {
      const data = await api('/api/conversations/contacts');
      contacts = data.contacts;
    } catch (err) {
      alert('Erro ao carregar contatos: ' + err.message);
      return;
    }
    function contactRowHtml(c) {
      return `
      <div class="member-row contact-row" data-user-id="${c.id}" style="cursor:pointer">
        ${avatarHtml(c)}
        ${roleBadge(c.role, c.roleLabel)}
        <div><div class="name">${escapeHtml(c.name)}</div></div>
      </div>`;
    }
    const modal = openModal(`
      <h3>Nova conversa</h3>
      <p style="font-size:13px;color:#666">Responsaveis so podem falar com a equipe (nunca com outros responsaveis).</p>
      <input type="text" id="contact-search" class="search-input" placeholder="Buscar por nome..." style="margin-bottom:10px" />
      <div id="contact-rows">${contacts.map(contactRowHtml).join('') || '<p>Nenhum contato disponivel no momento.</p>'}</div>
      <div class="modal-actions"><button class="btn secondary" id="cancel-conversa">Fechar</button></div>
    `);
    function wireContactRows() {
      modal.querySelectorAll('.contact-row').forEach(row => {
        row.addEventListener('click', async () => {
          const userId = Number(row.dataset.userId);
          try {
            const data = await api('/api/conversations', { method: 'POST', body: { userId } });
            closeModal();
            await loadConversations();
            openConversation(data.conversation);
          } catch (err) {
            alert('Erro ao iniciar conversa: ' + err.message);
          }
        });
      });
    }
    wireContactRows();
    const searchInput = document.getElementById('contact-search');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        const q = searchInput.value.trim().toLowerCase();
        const filtered = q ? contacts.filter(c => c.name.toLowerCase().includes(q)) : contacts;
        document.getElementById('contact-rows').innerHTML =
          filtered.map(contactRowHtml).join('') || '<p>Nenhum contato encontrado.</p>';
        wireContactRows();
      });
      searchInput.focus();
    }
    document.getElementById('cancel-conversa').addEventListener('click', closeModal);
  });

  async function openConversation(conv) {
    state.chat = { type: 'conversation', id: conv.id, name: conv.other.name };
    state.replyingTo = null;
    hideReplyPreview();
    document.getElementById('view-chat').classList.remove('hidden');
    NAV_VIEWS.forEach(v => document.getElementById('view-' + v).classList.add('hidden'));
    document.querySelector('.nav-tabs').classList.add('hidden');
    document.getElementById('chat-turma-name').innerHTML =
      `${avatarHtml(conv.other, 'small')} ${escapeHtml(conv.other.name)} ${roleBadge(conv.other.role, conv.other.roleLabel)}`;
    document.getElementById('btn-invite').classList.add('hidden');
    document.getElementById('btn-members').classList.add('hidden');
    document.getElementById('btn-poll').classList.add('hidden');
    document.getElementById('chat-input-bar').classList.remove('hidden');
    document.getElementById('audit-note').classList.add('hidden');
    document.getElementById('chat-messages').innerHTML = '';

    state.socket.emit('join_conversation', conv.id);
    const data = await api(`/api/conversations/${conv.id}/messages`);
    data.messages.forEach(appendMessage);
    scrollChatToBottom();
    markConversationAsRead(conv.id);
  }

  // ------------------------------------------------------------------
  // Auditoria de conversas privadas (Direcao) - visualizacao somente leitura
  // ------------------------------------------------------------------
  async function loadAuditoria() {
    let conversations = [];
    try {
      const data = await api('/api/admin/conversations');
      conversations = data.conversations;
    } catch (err) {
      document.getElementById('auditoria-list').innerHTML = `<div class="empty-state">Erro ao carregar: ${escapeHtml(err.message)}</div>`;
      return;
    }
    state.auditoriaConversations = conversations;
    renderAuditoriaList(conversations);
    document.getElementById('auditoria-search').oninput = () => {
      const q = document.getElementById('auditoria-search').value.trim().toLowerCase();
      const filtered = !q ? conversations : conversations.filter(c =>
        (c.userA && c.userA.name.toLowerCase().includes(q)) || (c.userB && c.userB.name.toLowerCase().includes(q))
      );
      renderAuditoriaList(filtered);
    };
  }

  function renderAuditoriaList(conversations) {
    const list = document.getElementById('auditoria-list');
    list.innerHTML = '';
    if (!conversations.length) {
      list.innerHTML = '<div class="empty-state">Nenhuma conversa encontrada.</div>';
      return;
    }
    conversations.forEach(c => {
      const nameA = c.userA ? c.userA.name : '?';
      const nameB = c.userB ? c.userB.name : '?';
      const card = el(`<div class="turma-card conversa-card">
        <h3>${escapeHtml(nameA)} ↔ ${escapeHtml(nameB)}</h3>
        <p>${c.lastMessagePreview ? escapeHtml(c.lastMessagePreview) : 'Nenhuma mensagem ainda'} · ${c.messageCount} mensagem(ns)</p>
      </div>`);
      card.addEventListener('click', () => openAuditConversation(c));
      list.appendChild(card);
    });
  }

  async function openAuditConversation(conv) {
    const nameA = conv.userA ? conv.userA.name : '?';
    const nameB = conv.userB ? conv.userB.name : '?';
    state.chat = { type: 'audit', id: conv.id, name: `${nameA} ↔ ${nameB}` };
    document.getElementById('view-chat').classList.remove('hidden');
    NAV_VIEWS.forEach(v => document.getElementById('view-' + v).classList.add('hidden'));
    document.querySelector('.nav-tabs').classList.add('hidden');
    document.getElementById('chat-turma-name').textContent = `${nameA} ↔ ${nameB}`;
    document.getElementById('btn-invite').classList.add('hidden');
    document.getElementById('btn-members').classList.add('hidden');
    document.getElementById('btn-poll').classList.add('hidden');
    document.getElementById('chat-input-bar').classList.add('hidden');
    document.getElementById('audit-note').classList.remove('hidden');
    document.getElementById('chat-messages').innerHTML = '';

    try {
      const data = await api(`/api/admin/conversations/${conv.id}/messages`);
      data.messages.forEach(appendMessage);
      scrollChatToBottom();
    } catch (err) {
      alert('Erro ao carregar conversa: ' + err.message);
    }
  }

  function markConversationAsRead(conversationId) {
    const c = state.conversations.find(x => x.id === conversationId);
    if (c) c.unread_count = 0;
    api(`/api/conversations/${conversationId}/read`, { method: 'POST' }).catch(() => {});
  }

  // ------------------------------------------------------------------
  // Cardapio
  // ------------------------------------------------------------------
  const MEAL_TYPES = ['Café da Manhã', 'Almoço', 'Café da Tarde', 'Lanche Final'];

  document.getElementById('cardapio-date').addEventListener('change', loadCardapio);

  async function loadCardapio() {
    const date = document.getElementById('cardapio-date').value || todayStr();
    const data = await api('/api/cardapio?date=' + date);
    const list = document.getElementById('cardapio-list');
    list.innerHTML = '';
    if (!data.cardapio.length) {
      list.innerHTML = '<div class="empty-state">Nenhuma refeicao registrada para este dia.</div>';
      return;
    }
    data.cardapio.forEach(item => {
      const canDelete = item.created_by === state.user.id || CARDAPIO_ADMIN_ROLES.includes(state.user.role);
      const canEdit = CARDAPIO_EDIT_ROLES.includes(state.user.role);
      const card = el(`<div class="meal-card">
        <div class="meal-type">${escapeHtml(item.meal_type)}</div>
        <div class="meal-desc">${escapeHtml(item.description)}</div>
        <div class="meal-foot">
          <span>Publicado por ${escapeHtml(item.author_name)}</span>
          <span>
            ${canEdit ? '<button class="btn ghost" style="padding:2px 8px;font-size:11px" data-edit="' + item.id + '">editar</button>' : ''}
            ${canDelete ? '<button class="btn ghost" style="padding:2px 8px;font-size:11px" data-del="' + item.id + '">remover</button>' : ''}
          </span>
        </div>
      </div>`);
      const delBtn = card.querySelector('[data-del]');
      if (delBtn) delBtn.addEventListener('click', async () => {
        try { await api('/api/cardapio/' + item.id, { method: 'DELETE' }); loadCardapio(); }
        catch (err) { alert(err.message); }
      });
      const editBtn = card.querySelector('[data-edit]');
      if (editBtn) editBtn.addEventListener('click', () => openMealModal(item));
      list.appendChild(card);
    });
  }

  document.getElementById('btn-new-meal').addEventListener('click', () => openMealModal(null));

  function openMealModal(existingItem) {
    const isEdit = !!existingItem;
    const date = isEdit ? existingItem.date : (document.getElementById('cardapio-date').value || todayStr());
    openModal(`
      <h3>${isEdit ? 'Editar refeicao' : 'Adicionar refeicao'}</h3>
      <div class="field"><label>Data</label><input type="date" id="meal-date" value="${date}" /></div>
      <div class="field"><label>Refeicao</label>
        <select id="meal-type">${MEAL_TYPES.map(m => `<option${isEdit && m === existingItem.meal_type ? ' selected' : ''}>${m}</option>`).join('')}</select>
      </div>
      <div class="field"><label>O que foi oferecido</label><textarea id="meal-desc" rows="3" placeholder="Ex: Arroz, feijao, frango grelhado, salada e suco de laranja">${isEdit ? escapeHtml(existingItem.description) : ''}</textarea></div>
      <div class="error-msg" id="meal-error"></div>
      <div class="modal-actions">
        <button class="btn secondary" id="cancel-meal">Cancelar</button>
        <button class="btn" id="confirm-meal">Salvar</button>
      </div>
    `);
    document.getElementById('cancel-meal').addEventListener('click', closeModal);
    document.getElementById('confirm-meal').addEventListener('click', async () => {
      try {
        const body = {
          date: document.getElementById('meal-date').value,
          mealType: document.getElementById('meal-type').value,
          description: document.getElementById('meal-desc').value
        };
        if (isEdit) {
          await api('/api/cardapio/' + existingItem.id, { method: 'PUT', body });
        } else {
          await api('/api/cardapio', { method: 'POST', body });
        }
        closeModal();
        document.getElementById('cardapio-date').value = body.date;
        loadCardapio();
      } catch (err) {
        document.getElementById('meal-error').textContent = err.message;
      }
    });
  }

  // ------------------------------------------------------------------
  // Financeiro
  // ------------------------------------------------------------------
  document.getElementById('fin-month-filter').addEventListener('change', loadFinanceiro);
  document.getElementById('btn-fin-clear-month').addEventListener('click', () => {
    document.getElementById('fin-month-filter').value = '';
    loadFinanceiro();
  });

  async function loadFinanceiro() {
    const month = document.getElementById('fin-month-filter').value;
    const data = await api('/api/financeiro' + (month ? '?month=' + month : ''));
    document.getElementById('fin-receitas').textContent = fmtBRL(data.totals.receitas);
    document.getElementById('fin-despesas').textContent = fmtBRL(data.totals.despesas);
    document.getElementById('fin-saldo').textContent = fmtBRL(data.totals.saldo);
    const tbody = document.getElementById('fin-tbody');
    tbody.innerHTML = '';
    data.lancamentos.forEach(item => {
      const tr = el(`<tr>
        <td>${item.date.split('-').reverse().join('/')}</td>
        <td>${item.type === 'receita' ? 'Receita' : 'Despesa'}</td>
        <td>${escapeHtml(item.description)}</td>
        <td class="amount-${item.type}">${fmtBRL(item.amount)}</td>
        <td>${escapeHtml(item.author_name)}</td>
        <td>${FIN_DELETE_ROLES.includes(state.user.role) ? '<button class="btn ghost" style="padding:2px 8px;font-size:11px" data-del="' + item.id + '">x</button>' : ''}</td>
      </tr>`);
      const delBtn = tr.querySelector('[data-del]');
      if (delBtn) delBtn.addEventListener('click', async () => {
        if (!confirm('Remover este lancamento?')) return;
        await api('/api/financeiro/' + item.id, { method: 'DELETE' });
        loadFinanceiro();
      });
      tbody.appendChild(tr);
    });
  }

  // ------------------------------------------------------------------
  // Recados com ciencia obrigatoria
  // ------------------------------------------------------------------

  // Busca recados pendentes e comeca a mostrar um de cada vez, em tela cheia.
  async function checkPendingRecados() {
    try {
      const data = await api('/api/recados/pending');
      data.pending.forEach((r) => {
        if (!state.recadoQueue.some(q => q.id === r.id)) state.recadoQueue.push(r);
      });
      showNextRecado();
    } catch (err) {
      // silencioso: nao trava o app se essa checagem falhar
    }
  }

  function showNextRecado() {
    const overlay = document.getElementById('recado-overlay');
    if (!state.recadoQueue.length) {
      overlay.classList.add('hidden');
      return;
    }
    const r = state.recadoQueue[0];
    document.getElementById('recado-author').textContent = r.createdByName ? `Enviado por ${r.createdByName}` : '';
    const box = document.getElementById('recado-message');
    box.innerHTML = '';
    if (r.message) {
      const p = document.createElement('div');
      p.textContent = r.message;
      p.style.whiteSpace = 'pre-wrap';
      box.appendChild(p);
    }
    if (r.attachment) {
      renderRecadoAttachmentAuto(box, r.id, r.attachment);
    }
    overlay.classList.remove('hidden');
  }

  // Monta a foto/PDF anexado a um recado pra usar em listas (ex: tela de
  // gestao de recados) - imagem aparece direto, PDF vira um "chip" clicavel
  // que abre o visualizador do app.
  function renderRecadoAttachment(recadoId, attachment) {
    const url = `/api/recados/${recadoId}/attachment`;
    if (attachment.kind === 'imagem') {
      const img = el(`<img class="chat-thumb" style="max-width:100%;margin-top:8px" src="${url}" oncontextmenu="return false" draggable="false" />`);
      img.addEventListener('click', () => openImageViewer(url));
      return img;
    }
    const chip = el(`<div class="pdf-chip" style="margin-top:8px">📄 ${escapeHtml(attachment.name || 'Documento PDF')}</div>`);
    chip.addEventListener('click', () => openPdfViewer(url));
    return chip;
  }

  // Igual acima, mas para o popup de ciencia obrigatoria: aqui a imagem OU o
  // PDF aparecem prontos na tela, sem precisar clicar em nada pra abrir.
  function renderRecadoAttachmentAuto(container, recadoId, attachment) {
    const url = `/api/recados/${recadoId}/attachment`;
    if (attachment.kind === 'imagem') {
      const img = el(`<img class="chat-thumb" style="max-width:100%;max-height:none;margin-top:8px" src="${url}" oncontextmenu="return false" draggable="false" />`);
      img.addEventListener('click', () => openImageViewer(url));
      container.appendChild(img);
      return;
    }
    // PDF: renderiza as paginas direto dentro do card, igual ao visualizador
    // do chat, mas sem precisar abrir nada separado.
    const wrap = document.createElement('div');
    wrap.style.marginTop = '8px';
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.gap = '10px';
    container.appendChild(wrap);
    (async () => {
      try {
        const res = await fetch(url, { credentials: 'same-origin' });
        const buf = await res.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const viewport = page.getViewport({ scale: 1.1 });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.maxWidth = '100%';
          canvas.style.borderRadius = '8px';
          canvas.oncontextmenu = () => false;
          wrap.appendChild(canvas);
          await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        }
      } catch (err) {
        const chip = el(`<div class="pdf-chip">📄 ${escapeHtml(attachment.name || 'Documento PDF')} (toque para abrir)</div>`);
        chip.addEventListener('click', () => openPdfViewer(url));
        wrap.appendChild(chip);
      }
    })();
  }

  document.getElementById('btn-recado-ack').addEventListener('click', async () => {
    if (!state.recadoQueue.length) return;
    const r = state.recadoQueue[0];
    const btn = document.getElementById('btn-recado-ack');
    btn.disabled = true;
    try {
      await api(`/api/recados/${r.id}/ack`, { method: 'POST' });
      state.recadoQueue.shift();
      showNextRecado();
    } catch (err) {
      alert('Erro ao confirmar: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  async function loadRecadosScreen() {
    let announcements = [];
    try {
      const data = await api('/api/recados');
      announcements = data.announcements;
    } catch (err) {
      document.getElementById('recados-list').innerHTML = `<div class="empty-state">Erro ao carregar: ${escapeHtml(err.message)}</div>`;
      return;
    }
    const list = document.getElementById('recados-list');
    list.innerHTML = '';
    if (!announcements.length) {
      list.innerHTML = '<div class="empty-state">Nenhum recado enviado ainda.</div>';
      return;
    }
    announcements.forEach((a) => {
      const audience = a.audienceType === 'turma' ? `Turma: ${escapeHtml(a.turmaName || '?')}` : 'Todo mundo';
      const card = el(`<div class="recado-card-admin${a.canceled ? ' canceled' : ''}">
        ${a.message ? `<div class="recado-admin-msg">${escapeHtml(a.message)}</div>` : ''}
        <div class="recado-admin-meta">
          <span>${a.attachment ? (a.attachment.kind === 'imagem' ? '🖼️' : '📄') + ' anexo · ' : ''}${audience} · por ${escapeHtml(a.createdByName)} · ${fmtDateTime(a.createdAt)}${a.canceled ? ' · <b>cancelado</b>' : ''}</span>
          <span>
            <span class="recado-admin-progress">${a.ackedCount}/${a.total} confirmaram</span>
            <button class="btn ghost" style="padding:2px 8px;font-size:11px;margin-left:8px" data-view-acks="${a.id}">ver lista</button>
            ${(!a.canceled && a.canCancel) ? `<button class="btn ghost" style="padding:2px 8px;font-size:11px;margin-left:4px" data-cancel="${a.id}">cancelar</button>` : ''}
          </span>
        </div>
      </div>`);
      if (a.attachment) card.insertBefore(renderRecadoAttachment(a.id, a.attachment), card.querySelector('.recado-admin-meta'));
      card.querySelector('[data-view-acks]').addEventListener('click', () => openRecadoAcksModal(a.id));
      const cancelBtn = card.querySelector('[data-cancel]');
      if (cancelBtn) cancelBtn.addEventListener('click', async () => {
        if (!confirm('Cancelar este recado? Quem ainda nao viu deixa de receber.')) return;
        try {
          await api(`/api/recados/${a.id}`, { method: 'DELETE' });
          loadRecadosScreen();
        } catch (err) {
          alert('Erro ao cancelar: ' + err.message);
        }
      });
      list.appendChild(card);
    });
  }

  async function openRecadoAcksModal(recadoId) {
    let acks;
    try {
      acks = await api(`/api/recados/${recadoId}/acks`);
    } catch (err) {
      alert('Erro ao carregar confirmacoes: ' + err.message);
      return;
    }
    renderRecadoAcksModal(recadoId, acks);
  }

  function renderRecadoAcksModal(recadoId, acks) {
    const rows = acks.people.map(p => `
      <div class="acks-row">
        <span>${escapeHtml(p.name)}</span>
        <span class="${p.acked ? 'ack-yes' : 'ack-no'}">${p.acked ? '✔ confirmou' : 'aguardando'}</span>
      </div>`).join('');
    const modal = openModal(`
      <h3>Confirmações (${acks.ackedCount}/${acks.total})</h3>
      <div class="acks-list">${rows || '<p>Ninguem na audiencia deste recado.</p>'}</div>
      <div class="modal-actions"><button class="btn secondary" id="close-acks">Fechar</button></div>
    `);
    document.getElementById('close-acks').addEventListener('click', closeModal);
    modal.dataset.recadoId = recadoId;
  }

  document.getElementById('btn-new-recado').addEventListener('click', async () => {
    let turmas = [];
    try {
      const data = await api('/api/turmas/all');
      turmas = data.turmas;
    } catch (err) { /* segue sem a lista de turmas se falhar */ }
    openModal(`
      <h3>Novo recado</h3>
      <p style="font-size:13px;color:#666">Aparece em tela cheia assim que a pessoa abrir o app, e so some depois que ela der ciencia.</p>
      <div class="field"><label>Mensagem (opcional se anexar uma imagem/PDF)</label><textarea id="recado-text" rows="4" placeholder="Escreva o recado..."></textarea></div>
      <div class="field"><label>Anexar imagem ou PDF (opcional - pode ser um banner, cartaz, comunicado escaneado etc.)</label>
        <input type="file" id="recado-file" accept="image/*,application/pdf" />
        <div id="recado-file-preview" style="margin-top:8px"></div>
      </div>
      <div class="field"><label>Para quem</label>
        <select id="recado-audience">
          <option value="all">Todo mundo</option>
          <option value="turma">Uma turma especifica</option>
        </select>
      </div>
      <div class="field hidden" id="recado-turma-field"><label>Turma</label>
        <select id="recado-turma">${turmas.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('')}</select>
      </div>
      <div class="error-msg" id="recado-error"></div>
      <div class="modal-actions">
        <button class="btn secondary" id="cancel-recado">Cancelar</button>
        <button class="btn" id="confirm-recado">Enviar</button>
      </div>
    `);
    document.getElementById('recado-audience').addEventListener('change', (e) => {
      document.getElementById('recado-turma-field').classList.toggle('hidden', e.target.value !== 'turma');
    });
    document.getElementById('recado-file').addEventListener('change', (e) => {
      const file = e.target.files[0];
      const preview = document.getElementById('recado-file-preview');
      preview.innerHTML = '';
      if (file) {
        preview.textContent = `📎 ${file.name}`;
      }
    });
    document.getElementById('cancel-recado').addEventListener('click', closeModal);
    document.getElementById('confirm-recado').addEventListener('click', async () => {
      const message = document.getElementById('recado-text').value.trim();
      const file = document.getElementById('recado-file').files[0] || null;
      const audienceType = document.getElementById('recado-audience').value;
      const turmaId = audienceType === 'turma' ? Number(document.getElementById('recado-turma').value) : null;
      if (!message && !file) {
        document.getElementById('recado-error').textContent = 'Escreva o recado ou anexe uma imagem/PDF';
        return;
      }
      if (audienceType === 'turma' && !turmaId) {
        document.getElementById('recado-error').textContent = 'Escolha uma turma';
        return;
      }
      const fd = new FormData();
      fd.append('message', message);
      fd.append('audienceType', audienceType);
      if (turmaId) fd.append('turmaId', turmaId);
      if (file) fd.append('file', file);
      try {
        await api('/api/recados', { method: 'POST', body: fd });
        closeModal();
        loadRecadosScreen();
      } catch (err) {
        document.getElementById('recado-error').textContent = err.message;
      }
    });
  });

  // ------------------------------------------------------------------
  // Usuarios / redefinir senha (para direcao e gestor)
  // ------------------------------------------------------------------
  let usuariosCache = [];

  async function loadUsuarios() {
    const data = await api('/api/admin/users');
    usuariosCache = data.users;
    document.getElementById('usuarios-search').value = '';
    renderUsuarios(usuariosCache);
  }

  function renderUsuarios(list) {
    const box = document.getElementById('usuarios-list');
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = '<p style="color:#999;font-size:13px">Nenhum usuario encontrado.</p>';
      return;
    }
    list.forEach(u => {
      const row = el(`<div class="member-row">
        ${avatarHtml(u, 'small')}
        <div>
          <div class="name">${escapeHtml(u.name)}</div>
          <div class="phone">${escapeHtml(formatPhoneDisplay(u.phone))}</div>
        </div>
        ${roleBadge(u.role, u.roleLabel)}
        <div class="spacer"></div>
        ${u.id === state.user.id ? '<span style="font-size:11px;color:#999">(voce)</span>' : `
          <button class="btn secondary" style="padding:5px 10px;font-size:12px" data-reset="${u.id}">Redefinir senha</button>
          <button class="btn secondary" style="padding:5px 10px;font-size:12px" data-role="${u.id}">Alterar papel</button>
          <button class="btn ghost" style="padding:5px 10px;font-size:12px;color:var(--red)" data-del="${u.id}">Excluir</button>
        `}
      </div>`);
      const resetBtn = row.querySelector('[data-reset]');
      if (resetBtn) resetBtn.addEventListener('click', () => openResetPasswordModal(u));
      const roleBtn = row.querySelector('[data-role]');
      if (roleBtn) roleBtn.addEventListener('click', () => openChangeRoleModal(u));
      const delBtn = row.querySelector('[data-del]');
      if (delBtn) delBtn.addEventListener('click', () => confirmDeleteUsuario(u));
      box.appendChild(row);
    });
  }

  function formatPhoneDisplay(phone) {
    if (!phone) return '';
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 10) return phone;
    const ddd = digits.slice(0, 2);
    const rest = digits.slice(2);
    return rest.length === 9
      ? `(${ddd}) ${rest.slice(0, 5)}-${rest.slice(5)}`
      : `(${ddd}) ${rest.slice(0, 4)}-${rest.slice(4)}`;
  }

  document.getElementById('usuarios-search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) return renderUsuarios(usuariosCache);
    renderUsuarios(usuariosCache.filter(u =>
      u.name.toLowerCase().includes(q) || (u.phone || '').includes(q.replace(/\D/g, ''))
    ));
  });

  function openResetPasswordModal(user) {
    openModal(`
      <h3>Redefinir senha</h3>
      <p style="font-size:13px;color:#666">
        Definindo uma nova senha para <b>${escapeHtml(user.name)}</b> (${roleBadge(user.role, user.roleLabel)}).
        Depois de salvar, avise essa senha diretamente para a pessoa.
      </p>
      <div class="field"><label>Nova senha</label><input type="password" id="reset-pw" minlength="6" placeholder="Minimo 6 caracteres" /></div>
      <div class="field"><label>Confirmar nova senha</label><input type="password" id="reset-pw-confirm" minlength="6" /></div>
      <div class="error-msg" id="reset-pw-error"></div>
      <div class="modal-actions">
        <button class="btn secondary" id="cancel-reset-pw">Cancelar</button>
        <button class="btn" id="confirm-reset-pw">Salvar nova senha</button>
      </div>
    `);
    document.getElementById('cancel-reset-pw').addEventListener('click', closeModal);
    document.getElementById('confirm-reset-pw').addEventListener('click', async () => {
      const errBox = document.getElementById('reset-pw-error');
      const pw = document.getElementById('reset-pw').value;
      const pwConfirm = document.getElementById('reset-pw-confirm').value;
      if (pw.length < 6) { errBox.textContent = 'A senha precisa ter pelo menos 6 caracteres'; return; }
      if (pw !== pwConfirm) { errBox.textContent = 'As senhas nao coincidem'; return; }
      try {
        await api('/api/admin/users/' + user.id + '/reset-password', { method: 'POST', body: { newPassword: pw } });
        closeModal();
        alert(`Senha de ${user.name} redefinida. Avise a nova senha para essa pessoa.`);
      } catch (err) {
        errBox.textContent = err.message;
      }
    });
  }

  const ROLE_OPTIONS_HTML = `
    <optgroup label="Familia"><option value="pai">Responsavel (pai/mae)</option></optgroup>
    <optgroup label="Sala">
      <option value="professora_regente">Professora Regente</option>
      <option value="professora_auxiliar">Professora Auxiliar</option>
      <option value="estagiaria">Estagiaria</option>
    </optgroup>
    <optgroup label="Cozinha"><option value="cozinha">Cozinha</option></optgroup>
    <optgroup label="Direcao">
      <option value="diretora">Diretora</option>
      <option value="coordenadora_pedagogica">Coordenadora Pedagogica</option>
      <option value="secretaria">Secretaria</option>
      <option value="gestor">Gestor</option>
    </optgroup>`;

  function openChangeRoleModal(user) {
    openModal(`
      <h3>Alterar papel</h3>
      <p style="font-size:13px;color:#666">
        Corrigindo o papel de <b>${escapeHtml(user.name)}</b>. Papel atual: ${roleBadge(user.role, user.roleLabel)}
      </p>
      <div class="field">
        <label>Novo papel</label>
        <select id="change-role-select">${ROLE_OPTIONS_HTML}</select>
      </div>
      <div class="error-msg" id="change-role-error"></div>
      <div class="modal-actions">
        <button class="btn secondary" id="cancel-change-role">Cancelar</button>
        <button class="btn" id="confirm-change-role">Salvar</button>
      </div>
    `);
    document.getElementById('change-role-select').value = user.role;
    document.getElementById('cancel-change-role').addEventListener('click', closeModal);
    document.getElementById('confirm-change-role').addEventListener('click', async () => {
      const errBox = document.getElementById('change-role-error');
      const newRole = document.getElementById('change-role-select').value;
      try {
        await api('/api/admin/users/' + user.id + '/role', { method: 'PUT', body: { role: newRole } });
        closeModal();
        loadUsuarios();
      } catch (err) {
        errBox.textContent = err.message;
      }
    });
  }

  function confirmDeleteUsuario(user) {
    openModal(`
      <h3>Excluir usuario</h3>
      <p style="font-size:14px;color:#444;line-height:1.5">
        Tem certeza que quer excluir <b>${escapeHtml(user.name)}</b> (${roleBadge(user.role, user.roleLabel)})?
        A pessoa vai sair de todas as turmas e nao vai mais conseguir entrar no app.
        O historico de mensagens, cardapio e financeiro que ela ja registrou continua visivel normalmente.
      </p>
      <div class="error-msg" id="del-usuario-error"></div>
      <div class="modal-actions">
        <button class="btn secondary" id="cancel-del-usuario">Cancelar</button>
        <button class="btn danger" id="confirm-del-usuario">Excluir</button>
      </div>
    `);
    document.getElementById('cancel-del-usuario').addEventListener('click', closeModal);
    document.getElementById('confirm-del-usuario').addEventListener('click', async () => {
      try {
        await api('/api/admin/users/' + user.id, { method: 'DELETE' });
        closeModal();
        loadUsuarios();
      } catch (err) {
        document.getElementById('del-usuario-error').textContent = err.message;
      }
    });
  }

  document.getElementById('btn-new-lancamento').addEventListener('click', () => {
    openModal(`
      <h3>Novo lancamento</h3>
      <div class="field"><label>Data</label><input type="date" id="fin-date" value="${todayStr()}" /></div>
      <div class="field"><label>Tipo</label>
        <select id="fin-type"><option value="receita">Receita</option><option value="despesa">Despesa</option></select>
      </div>
      <div class="field"><label>Descricao</label><input id="fin-desc" placeholder="Ex: Mensalidade / Compra de material de limpeza" /></div>
      <div class="field"><label>Valor (R$)</label><input type="number" id="fin-amount" min="0" step="0.01" /></div>
      <div class="error-msg" id="fin-error"></div>
      <div class="modal-actions">
        <button class="btn secondary" id="cancel-fin">Cancelar</button>
        <button class="btn" id="confirm-fin">Salvar</button>
      </div>
    `);
    document.getElementById('cancel-fin').addEventListener('click', closeModal);
    document.getElementById('confirm-fin').addEventListener('click', async () => {
      try {
        await api('/api/financeiro', {
          method: 'POST',
          body: {
            date: document.getElementById('fin-date').value,
            type: document.getElementById('fin-type').value,
            description: document.getElementById('fin-desc').value,
            amount: document.getElementById('fin-amount').value
          }
        });
        closeModal();
        loadFinanceiro();
      } catch (err) {
        document.getElementById('fin-error').textContent = err.message;
      }
    });
  });

  // ------------------------------------------------------------------
  // Calendario escolar
  // ------------------------------------------------------------------
  const MONTH_NAMES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const WEEKDAY_ABBR = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

  // Calcula a data da Pascoa (algoritmo de Meeus/Jones/Butcher) - a partir
  // dela da pra calcular Carnaval, Sexta-feira Santa e Corpus Christi, que
  // mudam de data todo ano.
  function computeEaster(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(year, month - 1, day);
  }

  function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
  }

  function ymd(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  // Feriados nacionais do Brasil + o feriado municipal de Imbituba/SC
  // (Nossa Senhora da Conceicao, padroeira da cidade, 8 de dezembro).
  function getBrazilianHolidays(year) {
    const easter = computeEaster(year);
    const map = {};
    map[`${year}-01-01`] = 'Confraternização Universal';
    map[ymd(addDays(easter, -48))] = 'Carnaval';
    map[ymd(addDays(easter, -47))] = 'Carnaval';
    map[ymd(addDays(easter, -2))] = 'Sexta-feira Santa';
    map[`${year}-04-21`] = 'Tiradentes';
    map[`${year}-05-01`] = 'Dia do Trabalho';
    map[ymd(addDays(easter, 60))] = 'Corpus Christi';
    map[`${year}-09-07`] = 'Independência do Brasil';
    map[`${year}-10-12`] = 'Nossa Senhora Aparecida';
    map[`${year}-11-02`] = 'Finados';
    map[`${year}-11-15`] = 'Proclamação da República';
    map[`${year}-11-20`] = 'Dia da Consciência Negra';
    map[`${year}-12-08`] = 'Nossa Sra. da Conceição - padroeira de Imbituba';
    map[`${year}-12-25`] = 'Natal';
    return map;
  }

  async function loadCalendario() {
    const y = state.calMonth.getFullYear();
    const m = String(state.calMonth.getMonth() + 1).padStart(2, '0');
    document.getElementById('cal-month-label').textContent = `${MONTH_NAMES[state.calMonth.getMonth()]} de ${y}`;
    let events = [];
    try {
      const data = await api(`/api/calendario?month=${y}-${m}`);
      events = data.events;
    } catch (err) { /* mostra o mes vazio se der erro */ }
    renderCalendarGrid(state.calMonth.getFullYear(), state.calMonth.getMonth(), events);
  }

  function renderCalendarGrid(year, monthIndex, events) {
    const grid = document.getElementById('cal-grid');
    grid.innerHTML = '';
    const holidays = Object.assign({}, getBrazilianHolidays(year), getBrazilianHolidays(year + 1), getBrazilianHolidays(year - 1));

    const eventsByDay = {};
    events.forEach(e => {
      (eventsByDay[e.date] = eventsByDay[e.date] || []).push(e);
    });

    const firstOfMonth = new Date(year, monthIndex, 1);
    const startWeekday = firstOfMonth.getDay(); // 0=domingo
    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
    const todayStr2 = todayStr();

    for (let i = 0; i < startWeekday; i++) {
      grid.appendChild(el('<div class="cal-day other-month"></div>'));
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(year, monthIndex, day);
      const dateStr = ymd(date);
      const weekday = date.getDay();
      const isWeekend = weekday === 0 || weekday === 6;
      const holidayName = holidays[dateStr];
      const dayEvents = eventsByDay[dateStr] || [];

      const cell = el(`<div class="cal-day${isWeekend ? ' weekend' : ''}${holidayName ? ' holiday' : ''}${dateStr === todayStr2 ? ' today' : ''}"></div>`);
      cell.appendChild(el(`<div class="cal-day-num">${day}</div>`));
      if (holidayName) {
        cell.appendChild(el(`<div class="cal-holiday-label" title="${escapeHtml(holidayName)}">${escapeHtml(holidayName)}</div>`));
      }
      dayEvents.forEach(ev => {
        const chip = el(`<div class="cal-event-chip" title="${escapeHtml(ev.title)}">${escapeHtml(ev.title)}</div>`);
        chip.addEventListener('click', (e) => { e.stopPropagation(); openEventoModal(ev); });
        cell.appendChild(chip);
      });
      if (CALENDARIO_EDIT_ROLES.includes(state.user.role)) {
        cell.style.cursor = 'pointer';
        cell.addEventListener('click', () => openEventoModal(null, dateStr));
      }
      grid.appendChild(cell);
    }
  }

  document.getElementById('cal-prev').addEventListener('click', () => {
    state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1);
    loadCalendario();
  });
  document.getElementById('cal-next').addEventListener('click', () => {
    state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1);
    loadCalendario();
  });
  document.getElementById('btn-new-evento').addEventListener('click', () => openEventoModal(null, todayStr()));

  // ev = evento existente (editar) ou null (criar novo); defaultDate usado so na criacao
  function openEventoModal(ev, defaultDate) {
    const canEdit = CALENDARIO_EDIT_ROLES.includes(state.user.role);
    if (ev && !canEdit) {
      openModal(`
        <h3>${escapeHtml(ev.title)}</h3>
        <p style="font-size:13px;color:#666">${ev.date.split('-').reverse().join('/')}</p>
        ${ev.description ? `<p style="font-size:14px;white-space:pre-wrap">${escapeHtml(ev.description)}</p>` : ''}
        <p style="font-size:12px;color:#999">Adicionado por ${escapeHtml(ev.authorName)}</p>
        <div class="modal-actions"><button class="btn" id="close-evento">Fechar</button></div>
      `);
      document.getElementById('close-evento').addEventListener('click', closeModal);
      return;
    }
    openModal(`
      <h3>${ev ? 'Editar evento' : 'Novo evento'}</h3>
      <div class="field"><label>Data</label><input type="date" id="evento-date" value="${ev ? ev.date : defaultDate}" /></div>
      <div class="field"><label>Título</label><input id="evento-title" placeholder="Ex: Reunião de pais, Festa da família, Arraiá cultural..." value="${ev ? escapeHtml(ev.title) : ''}" /></div>
      <div class="field"><label>Descrição (opcional)</label><textarea id="evento-desc" rows="3">${ev ? escapeHtml(ev.description || '') : ''}</textarea></div>
      <div class="error-msg" id="evento-error"></div>
      <div class="modal-actions">
        ${ev ? '<button class="btn ghost" id="delete-evento" style="color:var(--red)">Excluir</button>' : ''}
        <button class="btn secondary" id="cancel-evento">Cancelar</button>
        <button class="btn" id="confirm-evento">Salvar</button>
      </div>
    `);
    document.getElementById('cancel-evento').addEventListener('click', closeModal);
    const delBtn = document.getElementById('delete-evento');
    if (delBtn) delBtn.addEventListener('click', async () => {
      if (!confirm('Excluir este evento do calendário?')) return;
      try {
        await api('/api/calendario/' + ev.id, { method: 'DELETE' });
        closeModal();
        loadCalendario();
      } catch (err) {
        document.getElementById('evento-error').textContent = err.message;
      }
    });
    document.getElementById('confirm-evento').addEventListener('click', async () => {
      const errBox = document.getElementById('evento-error');
      const body = {
        date: document.getElementById('evento-date').value,
        title: document.getElementById('evento-title').value.trim(),
        description: document.getElementById('evento-desc').value.trim()
      };
      if (!body.title) { errBox.textContent = 'Informe um título para o evento'; return; }
      try {
        if (ev) {
          await api('/api/calendario/' + ev.id, { method: 'PUT', body });
        } else {
          await api('/api/calendario', { method: 'POST', body });
        }
        closeModal();
        loadCalendario();
      } catch (err) {
        errBox.textContent = err.message;
      }
    });
  }

  // ------------------------------------------------------------------
  // PWA: registrar service worker + botao "Instalar app"
  // ------------------------------------------------------------------
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // se falhar (ex: navegador antigo), o app continua funcionando normalmente pelo navegador
      });
    });
  }

  function isStandaloneDisplay() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function setupInstallPrompt() {
    const installButtons = Array.from(document.querySelectorAll('.btn-install-app'));
    if (isStandaloneDisplay() || !installButtons.length) return;

    let deferredPrompt = null;

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      installButtons.forEach((btn) => btn.classList.remove('hidden'));
    });

    installButtons.forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
        installButtons.forEach((b) => b.classList.add('hidden'));
      });
    });

    window.addEventListener('appinstalled', () => {
      installButtons.forEach((btn) => btn.classList.add('hidden'));
      const hint = document.getElementById('ios-install-hint');
      if (hint) hint.classList.add('hidden');
    });

    // iOS Safari nao dispara "beforeinstallprompt" - mostra instrucao manual em vez do botao
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isIOS) {
      const hint = document.getElementById('ios-install-hint');
      if (hint) hint.classList.remove('hidden');
    }
  }

  // ------------------------------------------------------------------
  // Notificacoes push (aviso de mensagem recebida mesmo com o app fechado)
  // ------------------------------------------------------------------
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  async function setupPushNotifications() {
    const btn = document.getElementById('btn-enable-push');
    if (!btn) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') return;
    if (Notification.permission === 'denied') return; // usuario ja negou no navegador, nao insiste

    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) return; // ja esta inscrito, nao precisa mostrar o botao

      btn.classList.remove('hidden');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const { publicKey } = await api('/api/push/vapid-public-key');
          if (!publicKey) {
            alert('As notificacoes push ainda nao foram configuradas neste servidor. Fale com quem administra o app.');
            return;
          }
          const sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey)
          });
          await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
          btn.classList.add('hidden');
        } catch (err) {
          if (Notification.permission === 'denied') {
            alert('As notificacoes foram bloqueadas no navegador. Para ativar, mude a permissao de notificacao desse site nas configuracoes do navegador.');
          } else {
            alert('Nao foi possivel ativar as notificacoes: ' + err.message);
          }
        } finally {
          btn.disabled = false;
        }
      });
    } catch (err) { /* service worker ainda nao pronto - o botao so nao aparece */ }
  }

  // Quando a pessoa clica numa notificacao push com o app ja aberto em alguma
  // aba, o service worker manda essa mensagem pra gente abrir a conversa certa
  // sem precisar recarregar a pagina inteira.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'notification-click' && event.data.url && state.user) {
        openDeepLinkFromUrl(event.data.url);
      }
    });
  }

  registerServiceWorker();
  setupInstallPrompt();
  boot();
})();
