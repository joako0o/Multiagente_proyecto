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
  /** Catálogo de skills: [{ name, description, sourceId, license, fileCount }] */
  skills: [],
  /** Resultado de la última búsqueda en la barra lateral: [{ name, score, matched }] o null (= sin filtro). */
  skillRanking: null,
  /** Asignación manual en el formulario de nueva sesión: { agentId: [skill, …] }. */
  draftSkills: {},
  /** Agente cuyo selector de skills está abierto en el formulario. */
  draftPickerAgent: null,
  /** Sesión abierta en el panel. */
  currentId: null,
  currentStatus: 'idle',
  currentMaxTurns: 15,
  /** Objetivo escrito antes de que exista sesión; se envía en cuanto se crea. */
  pendingPrompt: null,
  /** Pestaña activa del área central: 'messages' | 'files'. */
  tab: 'messages',
  /** Carpeta abierta en el explorador (relativa al workspace). */
  filesDir: '',
  /** Archivo previsualizado. */
  filesSelected: null
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
      state.skills = event.data.skills || [];
      renderAgents();
      renderTeamCheckboxes();
      renderSkills();
      renderSkillAssignments();
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
      // El arquitecto puede haber asignado skills o redefinido el equipo: refrescamos la cabecera.
      if (isCurrent && event.data.role === 'system') refreshSessionHeader();
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
      if (isCurrent && state.tab === 'files' && event.data.status !== 'active') loadFiles();
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

/* --- Skills ------------------------------------------------------------- */

/** Máximo de skills que se pintan en la barra lateral sin filtro (con cientos, se pide buscar). */
const SIDEBAR_SKILL_LIMIT = 40;

function renderSkills() {
  const list = $('skillList');
  list.innerHTML = '';
  $('skillsCount').textContent = state.skills.length ? `(${state.skills.length})` : '';
  if (!state.skills.length) {
    list.innerHTML = '<li class="muted">Sin skills. Configura SKILLS_SOURCES en .env o añade carpetas en .skills-cache/local/.</li>';
    return;
  }

  const byName = new Map(state.skills.map(s => [s.name, s]));
  let shown;
  if (state.skillRanking) {
    shown = state.skillRanking.map(r => ({ ...byName.get(r.name), matched: r.matched })).filter(s => s.name);
    if (!shown.length) list.innerHTML = '<li class="muted">Ninguna skill coincide. Prueba con otras palabras (español o inglés).</li>';
  } else {
    shown = state.skills.slice(0, SIDEBAR_SKILL_LIMIT);
  }

  for (const skill of shown) {
    const li = document.createElement('li');
    li.className = 'skill-item';
    li.title = 'Ver instrucciones';
    const match = skill.matched?.length ? `<span class="match">≈ ${escapeHtml(skill.matched.slice(0, 3).join(', '))}</span>` : '';
    li.innerHTML = `
      <span class="name">${escapeHtml(skill.name)}</span><span class="source">${escapeHtml(skill.sourceId)}${skill.fileCount ? ` · ${skill.fileCount} archivo(s)` : ''}</span>${match}
      <p>${escapeHtml(skill.description)}</p>`;
    li.addEventListener('click', () => openSkill(skill.name));
    list.appendChild(li);
  }
  if (!state.skillRanking && state.skills.length > SIDEBAR_SKILL_LIMIT) {
    const more = document.createElement('li');
    more.className = 'muted';
    more.textContent = `… y ${state.skills.length - SIDEBAR_SKILL_LIMIT} más. Usa el buscador para encontrarlas.`;
    list.appendChild(more);
  }
}

let skillSearchTimer = null;
function onSkillSearch(query) {
  clearTimeout(skillSearchTimer);
  const q = query.trim();
  if (!q) { state.skillRanking = null; renderSkills(); return; }
  skillSearchTimer = setTimeout(async () => {
    try {
      const data = await fetch(`/api/skills?q=${encodeURIComponent(q)}`).then(r => r.json());
      state.skillRanking = data.ranking || [];
      renderSkills();
    } catch (err) {
      log(`Búsqueda de skills falló: ${err.message}`, 'err');
    }
  }, 250);
}

/**
 * Filas "agente → skills elegidas" del formulario de nueva sesión. Cada fila
 * muestra chips (clic = quitar) y un botón "+ añadir" que abre un buscador
 * sobre el catálogo (con cientos de skills no caben checkboxes).
 */
function renderSkillAssignments() {
  const container = $('skillsAssign');
  container.innerHTML = '';
  $('skillsField').hidden = !state.skills.length;
  if (!state.skills.length) return;

  for (const agent of state.agents) {
    if (agent.id === 'antigravity') continue; // el arquitecto asigna, no ejecuta skills
    const row = document.createElement('div');
    row.className = 'agent-row' + (state.draftPickerAgent === agent.id ? ' active' : '');
    row.dataset.agent = agent.id;

    const chosen = state.draftSkills[agent.id] || [];
    const chips = chosen.map(name => `<span class="chip-skill" data-remove="${escapeHtml(name)}" title="Quitar">${escapeHtml(name)} ✕</span>`).join('');
    row.innerHTML = `<span>${agent.emoji} ${escapeHtml(agent.name)}</span>
      <div class="chips">${chips}<span class="chip-skill add" data-add="1">+ añadir skill</span></div>`;

    row.querySelectorAll('[data-remove]').forEach(chip => chip.addEventListener('click', () => {
      state.draftSkills[agent.id] = chosen.filter(n => n !== chip.dataset.remove);
      renderSkillAssignments();
    }));
    row.querySelector('[data-add]').addEventListener('click', () => {
      state.draftPickerAgent = state.draftPickerAgent === agent.id ? null : agent.id;
      renderSkillAssignments();
    });

    if (state.draftPickerAgent === agent.id) row.appendChild(buildSkillPicker(agent.id));
    container.appendChild(row);
  }
}

/** Buscador embebido: escribe → ranking del servidor → clic añade la skill al agente. */
function buildSkillPicker(agentId) {
  const picker = document.createElement('div');
  picker.className = 'picker';
  picker.innerHTML = `<input type="search" placeholder="Buscar skill (p. ej. series temporales, pptx, landing)…" autocomplete="off"><ul></ul>`;
  const input = picker.querySelector('input');
  const results = picker.querySelector('ul');

  const show = (items) => {
    results.innerHTML = '';
    for (const skill of items.slice(0, 12)) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="name">${escapeHtml(skill.name)}</span><span class="desc">${escapeHtml(skill.description)}</span>`;
      li.title = skill.description;
      li.addEventListener('click', () => {
        const list = state.draftSkills[agentId] || (state.draftSkills[agentId] = []);
        if (!list.includes(skill.name)) list.push(skill.name);
        renderSkillAssignments();
      });
      results.appendChild(li);
    }
    if (!items.length) results.innerHTML = '<li class="muted">Sin coincidencias</li>';
  };

  show(state.skills.slice(0, 12));
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) return show(state.skills.slice(0, 12));
    timer = setTimeout(async () => {
      const data = await fetch(`/api/skills?q=${encodeURIComponent(q)}`).then(r => r.json()).catch(() => ({}));
      const byName = new Map(state.skills.map(s => [s.name, s]));
      show((data.ranking || []).map(r => byName.get(r.name)).filter(Boolean));
    }, 200);
  });
  setTimeout(() => input.focus(), 0);
  return picker;
}

/** Asignación del formulario → { agentId: [skill, ...] } (solo agentes con alguna). */
function collectSkillAssignments() {
  const result = {};
  for (const [agentId, names] of Object.entries(state.draftSkills)) {
    if (names.length) result[agentId] = [...names];
  }
  return Object.keys(result).length ? result : undefined;
}

function renderSessionSkills(assignments) {
  const box = $('sessionSkills');
  const entries = Object.entries(assignments || {}).filter(([, names]) => names.length);
  box.hidden = !entries.length;
  box.innerHTML = entries
    .map(([agentId, names]) => `<span class="chip"><b>${agentName(agentId)}</b> → ${names.map(escapeHtml).join(', ')}</span>`)
    .join('');
}

async function refreshSessionHeader() {
  if (!state.currentId) return;
  try {
    const conv = await fetch(`/api/conversations/${state.currentId}`).then(r => r.json());
    renderSessionSkills(conv.skills);
  } catch { /* no crítico */ }
}

async function openSkill(name) {
  try {
    const skill = await fetch(`/api/skills/${encodeURIComponent(name)}`).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
    $('skillModalTitle').textContent = skill.name;
    $('skillModalMeta').textContent = [skill.sourceId, skill.license, skill.files.length ? `${skill.files.length} archivo(s): ${skill.files.slice(0, 6).join(', ')}${skill.files.length > 6 ? '…' : ''}` : 'solo SKILL.md']
      .filter(Boolean).join(' · ');
    $('skillModalBody').innerHTML = DOMPurify.sanitize(marked.parse(skill.body));
    $('skillModal').hidden = false;
  } catch (err) {
    log(`No se pudo abrir la skill: ${err.message}`, 'err');
  }
}

async function syncSkills() {
  const btn = $('syncSkillsBtn');
  btn.disabled = true;
  btn.textContent = '⇣ Sincronizando…';
  try {
    const data = await fetch('/api/skills/sync', { method: 'POST' }).then(r => r.json());
    if (data.error) throw new Error(data.error);
    state.skills = data.skills;
    renderSkills();
    renderSkillAssignments();
    for (const r of data.results) log(`Skills ${r.sourceId}: ${r.action}${r.detail ? ` (${r.detail})` : ''}`, r.ok ? 'ok' : 'err');
  } catch (err) {
    log(`Error sincronizando skills: ${err.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '⇣ Sincronizar repositorios';
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
    renderSessionSkills(conv.skills);

    const container = $('messages');
    container.innerHTML = '';
    conv.messages.forEach(appendMessage);

    state.filesDir = '';
    state.filesSelected = null;
    if (state.tab === 'files') loadFiles();

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

/* --- Archivos del workspace --------------------------------------------- */

function setTab(tab) {
  state.tab = tab;
  for (const btn of $('chatTabs').querySelectorAll('.tab')) btn.classList.toggle('active', btn.dataset.tab === tab);
  $('messages').hidden = tab !== 'messages';
  $('filesPanel').hidden = tab !== 'files';
  if (tab === 'files') loadFiles();
}

async function loadFiles() {
  const list = $('fileList');
  if (!state.currentId) {
    list.innerHTML = '<li class="muted">Selecciona una sesión</li>';
    return;
  }
  try {
    const url = `/api/conversations/${state.currentId}/files?dir=${encodeURIComponent(state.filesDir)}`;
    const data = await fetch(url).then(r => r.json());
    if (data.error) throw new Error(data.error);
    renderBreadcrumbs(data.workspace);
    list.innerHTML = '';
    if (state.filesDir) {
      const up = document.createElement('li');
      up.className = 'file-item';
      up.innerHTML = '<span class="fname">📁 ..</span>';
      up.addEventListener('click', () => { state.filesDir = state.filesDir.split('/').slice(0, -1).join('/'); loadFiles(); });
      list.appendChild(up);
    }
    if (!data.entries.length) list.innerHTML += '<li class="muted">Carpeta vacía</li>';
    for (const entry of data.entries) {
      const li = document.createElement('li');
      li.className = 'file-item' + (entry.path === state.filesSelected ? ' active' : '');
      li.title = entry.path;
      li.innerHTML = `<span class="fname">${entry.type === 'dir' ? '📁' : iconFor(entry.name)} ${escapeHtml(entry.name)}</span>` +
        `<span class="fmeta">${entry.type === 'dir' ? '' : formatBytes(entry.size)}</span>`;
      li.addEventListener('click', () => {
        if (entry.type === 'dir') { state.filesDir = entry.path; loadFiles(); }
        else previewFile(entry);
      });
      list.appendChild(li);
    }
  } catch (err) {
    list.innerHTML = `<li class="muted">No se pudo listar: ${escapeHtml(err.message)}</li>`;
  }
}

function renderBreadcrumbs(workspace) {
  const nav = $('fileBreadcrumbs');
  const parts = state.filesDir ? state.filesDir.split('/') : [];
  const crumbs = [`<a data-dir="" title="${escapeHtml(workspace)}">${escapeHtml(workspace.split(/[\\/]/).pop() || workspace)}</a>`];
  parts.forEach((part, i) => crumbs.push('›', `<a data-dir="${escapeHtml(parts.slice(0, i + 1).join('/'))}">${escapeHtml(part)}</a>`));
  nav.innerHTML = crumbs.join(' ');
  for (const a of nav.querySelectorAll('a')) a.addEventListener('click', () => { state.filesDir = a.dataset.dir; loadFiles(); });
}

async function previewFile(entry) {
  state.filesSelected = entry.path;
  for (const li of $('fileList').querySelectorAll('.file-item')) li.classList.toggle('active', li.title === entry.path);

  const box = $('filePreview');
  const rawUrl = `/api/conversations/${state.currentId}/files/raw?path=${encodeURIComponent(entry.path)}`;
  const header = `<div class="preview-header"><span>${escapeHtml(entry.path)} · ${formatBytes(entry.size)} · ${new Date(entry.modifiedAt).toLocaleString()}</span><a href="${rawUrl}" target="_blank" rel="noopener">Abrir en pestaña ↗</a></div>`;
  const ext = (entry.name.split('.').pop() || '').toLowerCase();

  try {
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
      box.innerHTML = header + `<img src="${rawUrl}" alt="${escapeHtml(entry.name)}">`;
    } else if (['html', 'htm'].includes(ext)) {
      // sandbox: el HTML generado por los agentes puede tener scripts (d3) pero no accede al panel.
      box.innerHTML = header + `<iframe src="${rawUrl}" sandbox="allow-scripts" title="${escapeHtml(entry.name)}"></iframe>`;
    } else if (ext === 'pdf') {
      box.innerHTML = header + `<object data="${rawUrl}" type="application/pdf" width="100%" height="600"><p class="muted">Tu navegador no muestra PDF embebido; usa "Abrir en pestaña".</p></object>`;
    } else {
      const text = await fetch(rawUrl).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); });
      if (ext === 'md') {
        box.innerHTML = header + `<div class="message-content">${DOMPurify.sanitize(marked.parse(text))}</div>`;
      } else if (ext === 'csv') {
        box.innerHTML = header + renderCsv(text);
      } else {
        box.innerHTML = header + `<pre>${escapeHtml(text.slice(0, 200_000))}${text.length > 200_000 ? '\n… (recortado)' : ''}</pre>`;
      }
    }
  } catch (err) {
    box.innerHTML = header + `<p class="muted">No se pudo cargar: ${escapeHtml(err.message)}</p>`;
  }
}

/** Tabla simple para CSV (separador coma o punto y coma, sin comillas anidadas complejas). */
function renderCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 500);
  if (!lines.length) return '<p class="muted">CSV vacío</p>';
  const sep = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
  const rows = lines.map(l => l.split(sep).map(c => c.replace(/^"|"$/g, '')));
  const head = rows[0].map(c => `<th>${escapeHtml(c)}</th>`).join('');
  const body = rows.slice(1).map(r => `<tr>${r.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('');
  return `<table class="csv"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>` +
    (text.split('\n').length > 500 ? '<p class="muted">Mostrando las primeras 500 filas.</p>' : '');
}

function iconFor(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return '🖼️';
  if (['html', 'htm'].includes(ext)) return '🌐';
  if (ext === 'md') return '📝';
  if (['csv', 'json', 'parquet', 'xlsx'].includes(ext)) return '📊';
  if (['py', 'js', 'ts', 'r', 'sql'].includes(ext)) return '📄';
  if (ext === 'pdf') return '📕';
  return '📄';
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* ========================================================================
   4. Acciones
   ======================================================================== */

function openModal() {
  state.draftSkills = {};
  state.draftPickerAgent = null;
  renderSkillAssignments();
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
      maxTurns: Number($('sessionMaxTurns').value) || 15,
      skills: collectSkillAssignments()
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
$('chatTabs').addEventListener('click', (e) => { const btn = e.target.closest('.tab'); if (btn) setTab(btn.dataset.tab); });
$('refreshFilesBtn').addEventListener('click', loadFiles);
$('syncSkillsBtn').addEventListener('click', syncSkills);
$('skillSearch').addEventListener('input', (e) => onSkillSearch(e.target.value));
$('closeSkillBtn').addEventListener('click', () => { $('skillModal').hidden = true; });
$('skillModal').addEventListener('click', (e) => { if (e.target.id === 'skillModal') $('skillModal').hidden = true; });
$('newSessionModal').addEventListener('click', (e) => { if (e.target.id === 'newSessionModal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); $('skillModal').hidden = true; } });

updateButtons();
connect();
