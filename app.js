/* global io, pdfjsLib */
(function () {
  'use strict';

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  const STAFF_ROLES = ['professor', 'cozinha', 'admin'];

  const state = {
    user: null,
    turmas: [],
    currentTurma: null,
    socket: null,
    inviteCode: null,
    inviteTurmaName: null
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

  formLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('login-error');
    errBox.textContent = '';
    try {
      const data = await api('/api/login', {
        method: 'POST',
        body: {
          email: document.getElementById('login-email').value,
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
          email: document.getElementById('reg-email').value,
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
    document.getElementById('btn-new-turma').classList.toggle('hidden', !['professor', 'admin'].includes(state.user.role));
    document.getElementById('btn-new-meal').classList.toggle('hidden', !STAFF_ROLES.includes(state.user.role));
    document.getElementById('btn-new-lancamento').classList.toggle('hidden', !['professor', 'admin'].includes(state.user.role));

    connectSocket();
    setupNav();
    document.getElementById('cardapio-date').value = todayStr();
    showView('turmas');
    await handlePendingInvite();
    loadTurmas();

    // limpa o parametro ?invite= da URL para nao repetir o fluxo em um refresh
    if (history.replaceState) {
      history.replaceState({}, '', location.pathname);
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
      if (state.currentTurma && msg.turmaId === state.currentTurma.id) {
        appendMessage(msg);
        scrollChatToBottom();
      }
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
    ['turmas', 'cardapio', 'financeiro'].forEach(v => {
      document.getElementById('view-' + v).classList.toggle('hidden', v !== name);
    });
    document.getElementById('view-chat').classList.add('hidden');
    document.querySelector('.nav-tabs').classList.remove('hidden');
    if (name === 'turmas') loadTurmas();
    if (name === 'cardapio') loadCardapio();
    if (name === 'financeiro') loadFinanceiro();
  }

  function leaveChatSocketIfNeeded() {
    if (state.currentTurma) {
      state.socket.emit('leave_turma', state.currentTurma.id);
      state.currentTurma = null;
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
      grid.innerHTML = `<div class="empty-state">Nenhuma turma ainda.${['professor','admin'].includes(state.user.role) ? ' Clique em "Criar turma" para comecar.' : ' Peca ao professor(a) o link de convite da turma.'}</div>`;
      return;
    }
    data.turmas.forEach(t => {
      const card = el(`<div class="turma-card">
        <h3>${escapeHtml(t.name)}</h3>
        <p>${t.member_count} participante(s)</p>
      </div>`);
      card.addEventListener('click', () => openChat(t));
      grid.appendChild(card);
    });
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
  // Chat
  // ------------------------------------------------------------------
  async function openChat(turma) {
    state.currentTurma = turma;
    document.getElementById('view-chat').classList.remove('hidden');
    ['turmas', 'cardapio', 'financeiro'].forEach(v => document.getElementById('view-' + v).classList.add('hidden'));
    document.querySelector('.nav-tabs').classList.add('hidden');
    document.getElementById('chat-turma-name').textContent = turma.name;
    document.getElementById('chat-messages').innerHTML = '';

    state.socket.emit('join_turma', turma.id);
    const data = await api(`/api/turmas/${turma.id}/messages`);
    data.messages.forEach(appendMessage);
    scrollChatToBottom();
  }

  document.getElementById('btn-back-turmas').addEventListener('click', () => showView('turmas'));

  document.getElementById('btn-invite').addEventListener('click', () => {
    if (state.currentTurma) showInviteModal(state.currentTurma);
  });

  document.getElementById('btn-members').addEventListener('click', async () => {
    if (!state.currentTurma) return;
    const data = await api(`/api/turmas/${state.currentTurma.id}/members`);
    const rows = data.members.map(m => `
      <div class="member-row">
        ${roleBadge(m.role, m.roleLabel)}
        <div>
          <div class="name">${escapeHtml(m.name)}</div>
          ${m.child_name ? `<div class="child">Responsavel por: ${escapeHtml(m.child_name)}</div>` : ''}
        </div>
      </div>`).join('');
    openModal(`
      <h3>Quem e quem</h3>
      <div>${rows || '<p>Nenhum participante ainda.</p>'}</div>
      <div class="modal-actions"><button class="btn" id="close-members">Fechar</button></div>
    `);
    document.getElementById('close-members').addEventListener('click', closeModal);
  });

  function appendMessage(msg) {
    const mine = msg.user.id === state.user.id;
    const wrap = el(`<div class="msg ${mine ? 'mine' : ''}"></div>`);
    const meta = el(`<div class="meta"></div>`);
    meta.innerHTML = `<b>${escapeHtml(msg.user.name)}</b> ${roleBadge(msg.user.role, msg.user.roleLabel)} <span>${fmtDateTime(msg.createdAt)}</span>`;
    const bubble = el(`<div class="bubble"></div>`);
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
    wrap.appendChild(meta);
    wrap.appendChild(bubble);
    document.getElementById('chat-messages').appendChild(wrap);
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
    if (!state.currentTurma) return;
    const text = chatText.value.trim();
    if (!text && !pendingFile) return;
    let attachmentId = null;
    try {
      if (pendingFile) {
        const fd = new FormData();
        fd.append('file', pendingFile);
        const up = await api(`/api/turmas/${state.currentTurma.id}/attachments`, { method: 'POST', body: fd });
        attachmentId = up.attachmentId;
      }
      await api(`/api/turmas/${state.currentTurma.id}/messages`, {
        method: 'POST',
        body: { content: text, attachmentId }
      });
      chatText.value = '';
      pendingFile = null;
      fileInput.value = '';
      document.getElementById('btn-attach').textContent = '📎';
    } catch (err) {
      alert('Erro ao enviar: ' + err.message);
    }
  }

  // ------------------------------------------------------------------
  // Cardapio
  // ------------------------------------------------------------------
  const MEAL_TYPES = ['Cafe da manha', 'Lanche da manha', 'Almoco', 'Lanche da tarde', 'Jantar'];

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
      const canDelete = STAFF_ROLES.includes(state.user.role);
      const card = el(`<div class="meal-card">
        <div class="meal-type">${escapeHtml(item.meal_type)}</div>
        <div class="meal-desc">${escapeHtml(item.description)}</div>
        <div class="meal-foot">
          <span>Publicado por ${escapeHtml(item.author_name)}</span>
          ${canDelete ? '<button class="btn ghost" style="padding:2px 8px;font-size:11px" data-del="' + item.id + '">remover</button>' : ''}
        </div>
      </div>`);
      const delBtn = card.querySelector('[data-del]');
      if (delBtn) delBtn.addEventListener('click', async () => {
        try { await api('/api/cardapio/' + item.id, { method: 'DELETE' }); loadCardapio(); }
        catch (err) { alert(err.message); }
      });
      list.appendChild(card);
    });
  }

  document.getElementById('btn-new-meal').addEventListener('click', () => {
    const date = document.getElementById('cardapio-date').value || todayStr();
    openModal(`
      <h3>Adicionar refeicao</h3>
      <div class="field"><label>Data</label><input type="date" id="meal-date" value="${date}" /></div>
      <div class="field"><label>Refeicao</label>
        <select id="meal-type">${MEAL_TYPES.map(m => `<option>${m}</option>`).join('')}</select>
      </div>
      <div class="field"><label>O que foi oferecido</label><textarea id="meal-desc" rows="3" placeholder="Ex: Arroz, feijao, frango grelhado, salada e suco de laranja"></textarea></div>
      <div class="error-msg" id="meal-error"></div>
      <div class="modal-actions">
        <button class="btn secondary" id="cancel-meal">Cancelar</button>
        <button class="btn" id="confirm-meal">Salvar</button>
      </div>
    `);
    document.getElementById('cancel-meal').addEventListener('click', closeModal);
    document.getElementById('confirm-meal').addEventListener('click', async () => {
      try {
        await api('/api/cardapio', {
          method: 'POST',
          body: {
            date: document.getElementById('meal-date').value,
            mealType: document.getElementById('meal-type').value,
            description: document.getElementById('meal-desc').value
          }
        });
        closeModal();
        document.getElementById('cardapio-date').value = document.getElementById('meal-date').value;
        loadCardapio();
      } catch (err) {
        document.getElementById('meal-error').textContent = err.message;
      }
    });
  });

  // ------------------------------------------------------------------
  // Financeiro
  // ------------------------------------------------------------------
  async function loadFinanceiro() {
    const data = await api('/api/financeiro');
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
        <td>${state.user.role === 'admin' ? '<button class="btn ghost" style="padding:2px 8px;font-size:11px" data-del="' + item.id + '">x</button>' : ''}</td>
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

  boot();
})();
