/**
 * Multi-Agent Bridge — lógica del panel web.
 *
 * Organización del archivo:
 *   1. Estado
 *   2. Conexión WebSocket y manejo de eventos del servidor
 *   3. Render: agentes, sesiones, cabecera, mensajes, registro
 *   4. Acciones del usuario (crear sesión, enviar, pausar, reanudar)
 *   5. Arranque
 *
 * No usa frameworks: DOM directo + marked (Markdown) + DOMPurify (sanitizado)
 * + highlight.js (código). Todo lo que se muestra de agentes viene de la API,
 * no hay nombres ni roles escritos aquí.
 */

/* ========================================================================
   1. Estado
   ======================================================================== */

const state = {
  ws: null,
  /** Catálogo de agentes recibido del servidor: [{ id, name, emoji, role, shortLabel }] */
  agents: [],
  /** Resúmenes de sesiones: [{ id, title, status, phase, ... }] */
  conversations: [],
  /** Sesión abierta en el panel. */
  currentId: null,
  currentStatus: 'idle',
  currentMaxTurns: 15,
  /** Objetivo escrito antes de que exista sesión; se envía en cuanto se crea. */
  pendingPrompt: null
};

const $ = (id) => document.getElementById(id);

const PHASE_LABELS = {
  PLANNING: 'Planificación',
  DEVELOPMENT: 'Desarrollo',
  EXECUTION: 'Ejecución / QA',
  REVIEW: 'Revisión',
  COMPLETED: 'Completado'
};

marked.setOptions({
  breaks: true,
  highlight: (code, lang) => (lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang }).value : hljs.highlightAuto(code).value)
});

/* ========================================================================
   2. WebSocket
   ======================================================================== */

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    setConnection(true);
    log('Conectado al servidor', 'ok');
  };

  ws.onclose = () => {
    setConnection(false);
    log('Conexión perdida. Reintentando en 3 s…', 'err');
    setTimeout(connect, 3000);
  };

  ws.onmessage = (raw) => {
    let event;
    try { event = JSON.parse(raw.data); } catch { return; }
    handleServerEvent(event);
  };
}

function send(command) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    log('No hay conexión con el servidor', 'err');
    return false;
  }
  state.ws.send(JSON.stringify(command));
  return true;
}

function handleServerEvent(event) {
  const isCurrent = event.conversationId === state.currentId;

  switch (event.type) {
    case 'connected':
      state.agents = event.data.agents;
      state.conversations = event.data.conversations;
      renderAgents();
      renderTeamCheckboxes();
      renderConversations();
      refreshAgentStatus();
      // Reabrir la última sesión tras una reconexión o recarga.
      if (state.currentId || state.conversations.length) {
        openConversation(state.currentId || state.conversations[state.conversations.length - 1].id);
      }
      break;

    case 'conversation_created':
      upsertConversation(event.data);
      openConversation(event.data.id);
      log(`Sesión creada: ${event.data.title}`, 'ok');
      if (state.pendingPrompt) {
        const prompt = state.pendingPrompt;
        state.pendingPrompt = null;
        startLoop(prompt, event.data.id);
      }
      break;

    case 'message':
      if (isCurrent) appendMessage(event.data);
      if (event.data.role === 'agent') log(`${agentName(event.data.agentId)} respondió`, 'info');
      break;

    case 'turn_change':
      touchConversation(event.conversationId, { currentTurn: event.data.turn, phase: event.data.phase });
      if (isCurrent) {
        setPhase(event.data.phase);
        $('turnInfo').textContent = `Turno: ${event.data.turn + 1} / ${state.currentMaxTurns} · ${event.data.agentName} trabajando…`;
      }
      log(`Turno ${event.data.turn + 1}: ${event.data.agentName} (${PHASE_LABELS[event.data.phase] || event.data.phase})`);
      break;

    case 'phase_change':
      touchConversation(event.conversationId, { phase: event.data.phase });
      if (isCurrent) setPhase(event.data.phase);
      break;

    case 'status':
      touchConversation(event.conversationId, { status: event.data.status, currentTurn: event.data.turns, phase: event.data.phase });
      if (isCurrent) {
        state.currentStatus = event.data.status;
        $('turnInfo').textContent = `Turno: ${event.data.turns} / ${state.currentMaxTurns}`;
        setPhase(event.data.phase);
        updateButtons();
      }
      if (event.data.status === 'completed') log('Ciclo finalizado', 'ok');
      if (event.data.status === 'paused') log('Ciclo en pausa', 'info');
      break;

    case 'error':
      log(`Error: ${event.data.message}`, 'err');
      break;
  }
}

/* ========================================================================
   3. Render
   ======================================================================== */

function setConnection(online) {
  $('connectionLabel').textContent = online ? 'Conectado' : 'Desconectado';
  $('connectionDot').classList.toggle('online', online);
}

function agentName(id) {
  if (id === 'user') return 'Usuario';
  if (id === 'system') return 'Sistema';
  const agent = state.agents.find(a => a.id === id);
  return agent ? `${agent.emoji} ${agent.name}` : id;
}

/* --- Agentes ------------------------------------------------------------ */

function renderAgents() {
  const list = $('agentList');
  list.innerHTML = '';
  for (const agent of state.agents) {
    const li = document.createElement('li');
    li.className = 'agent-item';
    li.style.setProperty('--agent-color', `var(--agent-${agent.id})`);
    li.innerHTML = `
      <h3>
        <span>${agent.emoji} ${escapeHtml(agent.name)}</span>
        <span class="agent-status" id="status-${agent.id}" title="">${escapeHtml(agent.shortLabel)}</span>
      </h3>
      <p>${escapeHtml(agent.role)}</p>`;
    list.appendChild(li);
  }
}

async function refreshAgentStatus() {
  try {
    const statuses = await fetch('/api/agents/status').then(r => r.json());
    for (const s of statuses) {
      const badge = $(`status-${s.id}`);
      if (!badge) continue;
      const level = !s.available ? 'err' : s.mode === 'fallback' ? 'warn' : 'ok';
      badge.className = `agent-status ${level}`;
      badge.textContent = !s.available ? 'No disponible' : s.mode === 'fallback' ? 'Modo limitado' : 'Disponible';
      badge.title = `${s.backend}\n${s.detail || ''}`.trim();
    }
  } catch (err) {
    log(`No se pudo consultar el estado de los agentes: ${err.message}`, 'err');
  }
}

function renderTeamCheckboxes() {
  const container = $('teamCheckboxes');
  container.innerHTML = '';
  for (const agent of state.agents) {
    const isArchitect = agent.id === 'antigravity';
    const label = document.createElement('label');
    if (isArchitect) label.className = 'locked';
    label.title = agent.role;
    label.innerHTML = `
      <input type="checkbox" value="${agent.id}" ${isArchitect || agent.id === 'opencode' ? 'checked' : ''} ${isArchitect ? 'disabled' : ''}>
      ${agent.emoji} ${escapeHtml(agent.name)}${isArchitect ? ' <small>(siempre)</small>' : ''}`;
    container.appendChild(label);
  }
}

/* --- Sesiones ----------------------------------------------------------- */

function upsertConversation(conv) {
  const summary = {
    id: conv.id, title: conv.title, status: conv.status, phase: conv.phase,
    currentTurn: conv.currentTurn, maxTurns: conv.maxTurns,
    projectPath: conv.projectPath, orchestrationMode: conv.orchestrationMode
  };
  const index = state.conversations.findIndex(c => c.id === conv.id);
  if (index >= 0) state.conversations[index] = { ...state.conversations[index], ...summary };
  else state.conversations.push(summary);
  renderConversations();
}

function touchConversation(id, patch) {
  const conv = state.conversations.find(c => c.id === id);
  if (!conv) return;
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) conv[key] = value;
  }
  renderConversations();
}

function renderConversations() {
  const list = $('conversationList');
  list.innerHTML = '';
  if (!state.conversations.length) {
    list.innerHTML = '<li class="muted">Sin sesiones todavía</li>';
    return;
  }
  const icons = { idle: '○', active: '●', paused: '❚❚', completed: '✓' };
  for (const conv of [...state.conversations].reverse()) {
    const li = document.createElement('li');
    li.className = 'conversation-item' + (conv.id === state.currentId ? ' active' : '');
    li.innerHTML = `
      <span class="title" title="${escapeHtml(conv.title)}">${escapeHtml(conv.title)}</span>
      <span class="meta">${icons[conv.status] || ''} ${conv.currentTurn}/${conv.maxTurns}</span>`;
    li.addEventListener('click', () => openConversation(conv.id));
    list.appendChild(li);
  }
}

async function openConversation(id) {
  // Se fija de inmediato para que los eventos que lleguen durante la carga
  // ya se atribuyan a esta sesión.
  state.currentId = id;
  try {
    const response = await fetch(`/api/conversations/${id}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const conv = await response.json();

    state.currentStatus = conv.status;
    state.currentMaxTurns = conv.maxTurns;

    $('conversationTitle').textContent = conv.title;
    $('workspaceInfo').textContent = `Workspace: ${conv.projectPath}`;
    $('workspaceInfo').title = conv.projectPath;
    $('modeInfo').textContent = `Modo: ${conv.orchestrationMode === 'autonomous' ? 'autónomo' : 'manual'}`;
    $('turnInfo').textContent = `Turno: ${conv.currentTurn} / ${conv.maxTurns}`;
    setPhase(conv.phase);

    const container = $('messages');
    container.innerHTML = '';
    conv.messages.forEach(appendMessage);

    updateButtons();
    upsertConversation(conv);
  } catch (err) {
    log(`No se pudo abrir la sesión: ${err.message}`, 'err');
  }
}

/* --- Cabecera y botones ------------------------------------------------- */

function setPhase(phase) {
  const badge = $('phaseBadge');
  badge.textContent = PHASE_LABELS[phase] || phase;
  badge.dataset.phase = phase;
}

function updateButtons() {
  const hasSession = Boolean(state.currentId);
  const status = state.currentStatus;
  $('pauseBtn').disabled = !hasSession || status !== 'active';
  $('resumeBtn').disabled = !hasSession || status !== 'paused';
  $('messageInput').placeholder = !hasSession || status === 'completed'
    ? 'Describe un objetivo… (se creará una sesión autónoma nueva)'
    : status === 'idle' ? 'Describe el objetivo para iniciar el ciclo…'
    : 'Añadir una nota al contexto del equipo…';
}

/* --- Mensajes ----------------------------------------------------------- */

function appendMessage(message) {
  const container = $('messages');
  $('emptyState')?.remove();

  const article = document.createElement('article');
  article.className = 'message';
  article.dataset.agent = message.agentId;
  article.style.setProperty('--agent-color', `var(--agent-${message.agentId}, var(--border))`);

  const isRich = message.role === 'agent';
  const html = isRich
    ? DOMPurify.sanitize(marked.parse(message.content))
    : escapeHtml(message.content).replace(/\n/g, '<br>');

  const backend = message.metadata?.sourceBackend ? `<span class="backend">${escapeHtml(message.metadata.sourceBackend)}</span>` : '';
  const verdict = message.metadata?.verdict ? `<span class="verdict ${message.metadata.verdict}">${message.metadata.verdict === 'APPROVED' ? 'APROBADO' : 'REQUIERE CAMBIOS'}</span>` : '';
  const time = new Date(message.timestamp).toLocaleTimeString();

  article.innerHTML = `
    <header class="message-header">
      <span>${agentName(message.agentId)}${backend}${verdict}</span>
      <time>${time}</time>
    </header>
    <div class="message-content">${html}</div>`;

  container.appendChild(article);
  container.scrollTop = container.scrollHeight;
}

/* --- Registro ----------------------------------------------------------- */

function log(text, level = '') {
  const area = $('log');
  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  area.appendChild(entry);
  while (area.children.length > 200) area.removeChild(area.firstChild);
  area.scrollTop = area.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text ?? '');
  return div.innerHTML;
}

/* ========================================================================
   4. Acciones
   ======================================================================== */

function openModal() {
  $('newSessionModal').hidden = false;
  $('sessionTitle').focus();
}

function closeModal() {
  $('newSessionModal').hidden = true;
}

function createSessionFromForm(event) {
  event.preventDefault();
  const mode = $('sessionMode').value;
  const agentIds = mode === 'manual'
    ? [...$('teamCheckboxes').querySelectorAll('input:checked')].map(i => i.value)
    : undefined;

  const ok = send({
    type: 'create_conversation',
    data: {
      title: $('sessionTitle').value.trim() || 'Nueva sesión',
      projectPath: $('sessionProjectPath').value.trim() || undefined,
      orchestrationMode: mode,
      agentIds,
      maxTurns: Number($('sessionMaxTurns').value) || 15
    }
  });
  if (ok) closeModal();
}

function submitComposer(event) {
  event.preventDefault();
  const input = $('messageInput');
  const content = input.value.trim();
  if (!content) return;

  if (!state.currentId || state.currentStatus === 'completed') {
    // Atajo: sin sesión (o con la actual ya cerrada), escribir crea una
    // sesión autónoma nueva y arranca el ciclo con ese objetivo.
    state.pendingPrompt = content;
    send({
      type: 'create_conversation',
      data: { title: content.slice(0, 60), orchestrationMode: 'autonomous', maxTurns: 15 }
    });
  } else if (state.currentStatus === 'idle') {
    startLoop(content);
  } else {
    send({ type: 'send_message', data: { conversationId: state.currentId, content } });
  }
  input.value = '';
}

function startLoop(prompt, conversationId = state.currentId) {
  send({ type: 'start_loop', data: { conversationId, initialPrompt: prompt } });
}

function pauseLoop() {
  send({ type: 'pause_loop', data: { conversationId: state.currentId } });
}

function resumeLoop() {
  send({ type: 'resume_loop', data: { conversationId: state.currentId } });
}

/* ========================================================================
   5. Arranque
   ======================================================================== */

$('newSessionBtn').addEventListener('click', openModal);
$('cancelSessionBtn').addEventListener('click', closeModal);
$('newSessionForm').addEventListener('submit', createSessionFromForm);
$('sessionMode').addEventListener('change', (e) => { $('teamField').hidden = e.target.value !== 'manual'; });
$('composer').addEventListener('submit', submitComposer);
$('pauseBtn').addEventListener('click', pauseLoop);
$('resumeBtn').addEventListener('click', resumeLoop);
$('refreshStatusBtn').addEventListener('click', refreshAgentStatus);
$('newSessionModal').addEventListener('click', (e) => { if (e.target.id === 'newSessionModal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

updateButtons();
connect();
