/**
 * Renderer UI. Holds no credentials and does no network work — everything goes
 * through the narrow `window.api` bridge exposed by the preload script.
 */

import type {
  LinkedProject,
  SessionRecord,
  SessionSummary,
  TranscriptEntry,
  AgentEvent,
  AppSettings,
  CredentialStatus,
  McpStatus,
  ModelInfo,
  ThinkingLevel,
  ToolCallRecord,
  UsageTotals,
} from '../shared/types.js';

interface Bootstrap {
  settings: AppSettings;
  credentials: CredentialStatus;
  encryptionAvailable: boolean;
  configPath: string;
  mcpStatus: McpStatus;
  version: string;
  session: SessionRecord | null;
  sessions: SessionSummary[];
}

interface SetKeyResult {
  ok: boolean;
  error?: string;
  status?: CredentialStatus;
  models?: ModelInfo[];
  encryptionAvailable?: boolean;
}

interface RendererApi {
  bootstrap(): Promise<Bootstrap>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  setApiKey(key: string): Promise<SetKeyResult>;
  clearApiKey(): Promise<CredentialStatus>;
  listModels(): Promise<{ models: ModelInfo[]; error: string | null }>;
  connectMcp(url?: string): Promise<McpStatus>;
  mcpStatus(): Promise<McpStatus>;
  disconnectMcp(): Promise<McpStatus>;
  send(text: string): Promise<{ ok: boolean; error?: string }>;
  cancel(): Promise<{ ok: boolean }>;
  resetConversation(): Promise<{ ok: boolean }>;
  resolveApproval(callId: string, approved: boolean, always: boolean): Promise<{ ok: boolean }>;
  openExternal(url: string): Promise<{ ok: boolean }>;
  onEvent(handler: (event: AgentEvent) => void): () => void;
  listSessions(): Promise<SessionSummary[]>;
  currentSession(): Promise<SessionRecord | null>;
  createSession(): Promise<SessionRecord>;
  openSession(id: string): Promise<SessionRecord | null>;
  renameSession(id: string, title: string): Promise<SessionRecord | null>;
  deleteSession(id: string): Promise<SessionRecord>;
  linkFolder(id: string): Promise<SessionRecord | null>;
  unlinkFolder(id: string): Promise<SessionRecord | null>;
  revealFolder(folderPath: string): Promise<{ ok: boolean }>;
  linkedProject(): Promise<LinkedProject | null>;
  launchEditor(): Promise<{ ok: boolean; error?: string }>;
}

declare global {
  interface Window {
    api: RendererApi;
  }
}

const api = window.api;

// ---------------------------------------------------------------- element refs

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error('Missing element #' + id);
  return el as T;
};

const transcript = $<HTMLElement>('transcript');
const input = $<HTMLTextAreaElement>('input');
const sendBtn = $<HTMLButtonElement>('sendBtn');
const stopBtn = $<HTMLButtonElement>('stopBtn');
const statusLine = $<HTMLElement>('statusLine');
const mcpPill = $<HTMLButtonElement>('mcpPill');
const mcpDot = $<HTMLElement>('mcpDot');
const mcpLabel = $<HTMLElement>('mcpLabel');
const modelPill = $<HTMLElement>('modelPill');
const usagePill = $<HTMLElement>('usagePill');
const settingsBtn = $<HTMLButtonElement>('settingsBtn');
const sessionsBtn = $<HTMLButtonElement>('sessionsBtn');
const sessionsOverlay = $<HTMLElement>('sessionsOverlay');
const closeSessionsBtn = $<HTMLButtonElement>('closeSessions');
const newSessionBtn = $<HTMLButtonElement>('newSessionBtn');
const sessionList = $<HTMLElement>('sessionList');
const sessionTitleEl = $<HTMLElement>('sessionTitle');
const folderChip = $<HTMLButtonElement>('folderChip');
const folderLabel = $<HTMLElement>('folderLabel');
const unlinkFolderBtn = $<HTMLButtonElement>('unlinkFolderBtn');
const launchEditorBtn = $<HTMLButtonElement>('launchEditorBtn');
const newChatBtn = $<HTMLButtonElement>('newChatBtn');
const overlay = $<HTMLElement>('overlay');
const closeSettings = $<HTMLButtonElement>('closeSettings');

const apiKeyInput = $<HTMLInputElement>('apiKey');
const saveKeyBtn = $<HTMLButtonElement>('saveKeyBtn');
const clearKeyBtn = $<HTMLButtonElement>('clearKeyBtn');
const keyStatus = $<HTMLElement>('keyStatus');
const keyError = $<HTMLElement>('keyError');
const getKeyLink = $<HTMLAnchorElement>('getKeyLink');

const modelSelect = $<HTMLSelectElement>('modelSelect');
const refreshModelsBtn = $<HTMLButtonElement>('refreshModelsBtn');
const modelHelp = $<HTMLElement>('modelHelp');
const thinkingLevel = $<HTMLSelectElement>('thinkingLevel');

const mcpUrlInput = $<HTMLInputElement>('mcpUrl');
const connectBtn = $<HTMLButtonElement>('connectBtn');
const mcpDetail = $<HTMLElement>('mcpDetail');

const requireApproval = $<HTMLInputElement>('requireApproval');
const maxSteps = $<HTMLInputElement>('maxSteps');
const extraInstructions = $<HTMLTextAreaElement>('extraInstructions');
const configPath = $<HTMLElement>('configPath');
const encNote = $<HTMLElement>('encNote');

// ---------------------------------------------------------------------- state

let settings: AppSettings;
let credentials: CredentialStatus;
let models: ModelInfo[] = [];
let mcp: McpStatus;
let running = false;
let session: SessionRecord | null = null;
let linkedProjectInfo: LinkedProject | null = null;

/** Live tool cards for the current turn, keyed by the model's call id. */
const toolCards = new Map<string, HTMLElement>();
/** The element the model's streaming text is appended into. */
let currentModelBubble: HTMLElement | null = null;

/** The setup notice and the example-prompt hints, both managed as derived state. */
let onboardingEl: HTMLElement | null = null;
let readyHintsEl: HTMLElement | null = null;

/** Wall-clock feedback: a single step can take over a minute at high effort. */
let turnStartedAt = 0;
let statusBase = '';
let statusTimer: number | null = null;

// ------------------------------------------------------------------ utilities

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Deliberately tiny Markdown subset — fenced code, inline code, bold, italic,
 * bullets and paragraphs. Everything is HTML-escaped first, so model output can
 * never inject markup.
 */
function renderMarkdown(src: string): string {
  const fences: string[] = [];
  let text = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code: string) => {
    fences.push('<pre><code>' + esc(code.replace(/\n$/, '')) + '</code></pre>');
    return '\u0000FENCE' + (fences.length - 1) + '\u0000';
  });

  text = esc(text);
  text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s.,;:!?)])/g, '$1<em>$2</em>');

  const blocks = text.split(/\n{2,}/).map((block) => {
    const trimmed = block.trim();
    if (!trimmed) return '';
    if (/^\u0000FENCE\d+\u0000$/.test(trimmed)) return trimmed;

    const lines = trimmed.split('\n');
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      const items = lines.map((l) => '<li>' + l.replace(/^\s*[-*]\s+/, '') + '</li>').join('');
      return '<ul>' + items + '</ul>';
    }
    return '<p>' + lines.join('<br />') + '</p>';
  });

  let html = blocks.filter(Boolean).join('\n');
  html = html.replace(/\u0000FENCE(\d+)\u0000/g, (_m, i: string) => fences[Number(i)] ?? '');
  return html;
}

function atBottom(): boolean {
  return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 120;
}

function scrollDown(force = false): void {
  if (force || atBottom()) transcript.scrollTop = transcript.scrollHeight;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  html?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

function pretty(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------- transcript

function addUserMessage(text: string): void {
  const wrap = el('div', 'msg msg-user');
  const bubble = el('div', 'bubble');
  bubble.textContent = text;
  wrap.appendChild(bubble);
  transcript.appendChild(wrap);
  scrollDown(true);
}

function modelBubble(): HTMLElement {
  if (currentModelBubble) return currentModelBubble;
  const wrap = el('div', 'msg msg-model');
  const bubble = el('div', 'bubble');
  wrap.appendChild(bubble);
  transcript.appendChild(wrap);
  currentModelBubble = bubble;
  return bubble;
}

function addModelText(text: string): void {
  const bubble = modelBubble();
  const block = el('div');
  block.innerHTML = renderMarkdown(text);
  bubble.appendChild(block);
  scrollDown();
}

function addThought(text: string): void {
  const details = el('details', 'thought');
  const summary = el('summary');
  summary.textContent = 'Reasoning';
  const body = el('div', 'thought-body');
  body.textContent = text;
  details.appendChild(summary);
  details.appendChild(body);
  transcript.appendChild(details);
  // Thoughts arriving means a new text block should start fresh after them.
  currentModelBubble = null;
  scrollDown();
}

/** Builds a notice element without placing it, so callers choose where it goes. */
function buildNotice(
  title: string,
  bodyHtml: string,
  opts: { error?: boolean; actions?: Array<{ label: string; onClick: () => void }> } = {},
): HTMLElement {
  const box = el('div', 'notice' + (opts.error ? ' error' : ''));
  box.appendChild(el('h3', undefined, esc(title)));
  const body = el('div');
  body.innerHTML = bodyHtml;
  box.appendChild(body);

  if (opts.actions?.length) {
    const row = el('div', 'notice-actions');
    for (const action of opts.actions) {
      const btn = el('button', 'ghost small');
      btn.textContent = action.label;
      btn.addEventListener('click', action.onClick);
      row.appendChild(btn);
    }
    box.appendChild(row);
  }

  return box;
}

/** Builds and appends a notice to the transcript. */
function addNotice(
  title: string,
  bodyHtml: string,
  opts: { error?: boolean; actions?: Array<{ label: string; onClick: () => void }> } = {},
): HTMLElement {
  const box = buildNotice(title, bodyHtml, opts);
  transcript.appendChild(box);
  currentModelBubble = null;
  scrollDown(true);
  return box;
}

const STATUS_ICON: Record<ToolCallRecord['status'], string> = {
  pending: '○',
  'awaiting-approval': '⏸',
  running: '◍',
  ok: '✓',
  error: '✕',
  denied: '⊘',
};

function renderToolCard(call: ToolCallRecord): HTMLElement {
  let card = toolCards.get(call.id);
  const isNew = !card;

  if (!card) {
    card = el('div', 'tool');
    const head = el('div', 'tool-head');
    head.innerHTML =
      '<span class="tool-icon"></span>' +
      '<span class="tool-name"></span>' +
      '<span class="badge"></span>' +
      '<span class="tool-time"></span>';
    const body = el('div', 'tool-body hidden');
    head.addEventListener('click', () => body.classList.toggle('hidden'));
    card.appendChild(head);
    card.appendChild(body);
    toolCards.set(call.id, card);
    transcript.appendChild(card);
    currentModelBubble = null;
  }

  card.classList.toggle('awaiting', call.status === 'awaiting-approval');
  card.classList.toggle('err', call.status === 'error' || call.status === 'denied');

  const icon = card.querySelector<HTMLElement>('.tool-icon');
  const name = card.querySelector<HTMLElement>('.tool-name');
  const badge = card.querySelector<HTMLElement>('.badge');
  const time = card.querySelector<HTMLElement>('.tool-time');
  const body = card.querySelector<HTMLElement>('.tool-body');

  if (icon) icon.textContent = STATUS_ICON[call.status];
  if (name) name.textContent = call.label;
  if (badge) {
    badge.textContent = call.risk === 'write' ? 'changes' : 'read';
    badge.className = 'badge ' + call.risk;
  }
  if (time) {
    time.textContent =
      call.durationMs !== null
        ? call.durationMs >= 1000
          ? (call.durationMs / 1000).toFixed(1) + 's'
          : call.durationMs + 'ms'
        : '';
  }

  if (body) {
    const sections: string[] = [];
    const args = pretty(call.args);
    if (args && args !== '{}') sections.push('<h4>Arguments</h4><pre>' + esc(args) + '</pre>');
    if (call.error) sections.push('<h4>Error</h4><pre class="err-text">' + esc(call.error) + '</pre>');
    if (call.result) sections.push('<h4>Result</h4><pre>' + esc(call.result) + '</pre>');
    if (!sections.length) sections.push('<pre>(no details yet)</pre>');
    body.innerHTML = sections.join('');
  }

  if (isNew) scrollDown();
  return card;
}

function renderApproval(call: ToolCallRecord): void {
  const card = renderToolCard(call);
  if (card.querySelector('.approve-row')) return;

  // Show what is about to happen without needing a click.
  const body = card.querySelector<HTMLElement>('.tool-body');
  body?.classList.remove('hidden');

  const row = el('div', 'approve-row');
  const note = el('span', 'spacer');
  note.textContent = 'Gemini wants to change your project.';
  row.appendChild(note);

  const decide = (approved: boolean, always: boolean) => {
    row.remove();
    void api.resolveApproval(call.id, approved, always);
  };

  const approve = el('button', 'primary small');
  approve.textContent = 'Approve';
  approve.addEventListener('click', () => decide(true, false));

  const all = el('button', 'ghost small');
  all.textContent = 'Approve all';
  all.title = 'Allow every remaining change for this conversation';
  all.addEventListener('click', () => decide(true, true));

  const deny = el('button', 'ghost small');
  deny.textContent = 'Decline';
  deny.addEventListener('click', () => decide(false, false));

  row.append(approve, all, deny);
  card.appendChild(row);

  // Expanding the card grows it after the scroll would have run, which can leave
  // the buttons just below the fold — and a turn that looks stuck is really a
  // turn waiting on a button the user cannot see. Scroll once layout has settled.
  requestAnimationFrame(() => {
    scrollDown(true);
    row.scrollIntoView({ block: 'nearest' });
  });
}

// ------------------------------------------------------------- header + state

function setRunning(value: boolean): void {
  running = value;
  sendBtn.classList.toggle('hidden', value);
  stopBtn.classList.toggle('hidden', !value);
  input.disabled = value;
  if (value) {
    turnStartedAt = Date.now();
  } else {
    if (statusTimer !== null) {
      window.clearInterval(statusTimer);
      statusTimer = null;
    }
    statusBase = '';
    turnStartedAt = 0;
    statusLine.textContent = '';
    statusLine.classList.remove('working');
  }
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  if (total < 60) return total + 's';
  return Math.floor(total / 60) + 'm ' + String(total % 60).padStart(2, '0') + 's';
}

function paintStatus(): void {
  if (!statusBase) {
    statusLine.textContent = '';
    return;
  }
  const elapsed = turnStartedAt ? '  ·  ' + formatElapsed(Date.now() - turnStartedAt) : '';
  statusLine.textContent = statusBase + elapsed;
}

function setStatus(text: string): void {
  statusBase = text;
  statusLine.classList.toggle('working', running && Boolean(text));
  paintStatus();

  // Tick once a second so a long step visibly progresses instead of looking hung.
  if (running && text) {
    if (statusTimer === null) statusTimer = window.setInterval(paintStatus, 1000);
  } else if (statusTimer !== null) {
    window.clearInterval(statusTimer);
    statusTimer = null;
  }
}

function renderMcpStatus(status: McpStatus): void {
  mcp = status;
  // The notice depends on this, so refresh it rather than leaving a stale one.
  queueMicrotask(updateOnboarding);
  mcpDot.className = 'dot ' + (status.connected ? 'on' : 'off');

  if (status.connected) {
    const n = status.toolsets.length;
    mcpLabel.textContent = 'Editor connected' + (n ? ' · ' + n + ' toolsets' : '');
    mcpPill.title = status.url + (n ? '\n' + status.toolsets.join('\n') : '');
  } else {
    mcpLabel.textContent = 'Editor not connected';
    mcpPill.title = status.error ?? status.url;
  }

  mcpUrlInput.value = status.url || settings.mcpUrl;

  if (status.connected) {
    const list = status.toolsets.length
      ? '<ul class="toolset-list">' +
        status.toolsets.map((t) => '<li><code>' + esc(t) + '</code></li>').join('') +
        '</ul>'
      : '';
    mcpDetail.innerHTML =
      '<span class="ok-text">Connected.</span> ' +
      esc(String(status.tools.length)) +
      ' top-level tools, ' +
      esc(String(status.toolsets.length)) +
      ' toolsets.' +
      list;
  } else {
    mcpDetail.innerHTML = status.error
      ? '<span class="err-text">' + esc(status.error) + '</span>'
      : 'Not connected.';
  }
}

function renderCredentials(): void {
  queueMicrotask(updateOnboarding);
  if (credentials.hasKey) {
    keyStatus.innerHTML =
      '<span class="ok-text">✓ Key saved</span> (…' +
      esc(credentials.hint ?? '') +
      ')' +
      (credentials.encrypted
        ? ' — encrypted with your Windows account.'
        : ' — <strong>this session only</strong>; the OS keychain is unavailable.');
    apiKeyInput.placeholder = 'Paste a new key to replace it';
  } else if (credentials.stale) {
    keyStatus.innerHTML =
      '<span class="err-text">Your saved key could not be decrypted</span>' +
      (credentials.hint ? ' (…' + esc(credentials.hint) + ')' : '') +
      ' and has been cleared. This happens when the OS encryption key is rotated. ' +
      'Paste the key again to restore it.';
    apiKeyInput.placeholder = 'AIza…';
  } else {
    keyStatus.innerHTML = 'No key saved yet. Gemini cannot run until you add one.';
    apiKeyInput.placeholder = 'AIza…';
  }
  clearKeyBtn.classList.toggle('hidden', !credentials.hasKey);
}

function renderModelOptions(): void {
  modelSelect.innerHTML = '';
  const seen = new Set<string>();

  for (const m of models) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.displayName === m.id ? m.id : m.displayName + '  (' + m.id + ')';
    modelSelect.appendChild(opt);
  }

  // Keep the saved model selectable even if the live list no longer offers it.
  if (settings.model && !seen.has(settings.model)) {
    const opt = document.createElement('option');
    opt.value = settings.model;
    opt.textContent = settings.model + '  (saved)';
    modelSelect.insertBefore(opt, modelSelect.firstChild);
  }

  modelSelect.value = settings.model;
  modelPill.textContent = settings.model;

  const chosen = models.find((m) => m.id === settings.model);
  modelHelp.textContent = chosen?.description ?? '';
}

function renderUsage(usage: UsageTotals): void {
  const total = usage.totalTokens || usage.inputTokens + usage.outputTokens;
  const tokens = total >= 1000 ? (total / 1000).toFixed(1) + 'k' : String(total);
  // Requests come first: free-tier Flash models cap around 20 per DAY, so the
  // request count is what actually runs out, long before tokens do.
  usagePill.textContent = usage.requests + ' req · ' + tokens + ' tok';
  usagePill.title =
    usage.requests +
    ' API requests this conversation (free-tier Flash models allow ~20/day; ' +
    'Flash-Lite allows far more)\n' +
    'Input ' + usage.inputTokens +
    ' · Output ' + usage.outputTokens +
    ' · Thinking ' + usage.thoughtTokens;
}

// -------------------------------------------------------------- onboarding

/**
 * The setup notice is derived state, not a one-off message: it is rebuilt whenever
 * the key or the editor connection changes, and removed entirely once both are in
 * place. Rendering it once at startup left it telling the user to start Unreal
 * while the title bar already said the editor was connected.
 */
function updateOnboarding(): void {
  const ready = credentials.hasKey && !credentials.stale && Boolean(mcp?.connected);

  // Nothing outstanding — drop the notice and stay out of the way.
  if (ready) {
    onboardingEl?.remove();
    onboardingEl = null;
    if (!transcript.children.length) showReadyHints();
    return;
  }

  readyHintsEl?.remove();
  readyHintsEl = null;

  const steps = outstandingSteps();
  const html = '<ol>' + steps.join('') + '</ol>';
  const title = steps.length > 1 ? 'Two things before you start' : 'One thing before you start';

  if (onboardingEl) {
    // Rebuild in place so it does not jump to the bottom of a live transcript.
    const heading = onboardingEl.querySelector('h3');
    const body = onboardingEl.querySelector('div');
    if (heading) heading.textContent = title;
    if (body) body.innerHTML = html;
    return;
  }

  onboardingEl = buildNotice(title, html, {
    actions: [{ label: 'Open Settings', onClick: openSettings }],
  });
  transcript.prepend(onboardingEl);
}

function outstandingSteps(): string[] {
  const steps: string[] = [];
  if (credentials.stale) {
    steps.push(
      '<li><strong>Re-enter your Gemini API key.</strong> The saved one could not be ' +
        'decrypted and has been cleared — paste it again in Settings.</li>',
    );
  } else if (!credentials.hasKey) {
    steps.push(
      '<li><strong>Add your Gemini API key.</strong> Open Settings and paste a key from ' +
        '<a href="https://aistudio.google.com/apikey" class="link">Google AI Studio</a>. ' +
        'It is encrypted with your Windows account and only ever sent to Google.</li>',
    );
  }
  if (!mcp?.connected) {
    steps.push(
      '<li><strong>Start Unreal Editor</strong> with the MCP plugin enabled, then press ' +
        '<em>Connect</em> in Settings. Default endpoint: <code>' +
        esc(settings.mcpUrl) +
        '</code></li>',
    );
  }
  return steps;
}

function showReadyHints(): void {
  readyHintsEl = buildNotice(
    'Ready',
    '<p>Connected to the editor and signed in. Try one of these:</p>' +
      '<ul>' +
      '<li>“What is in the current level?”</li>' +
      '<li>“Place a row of five cubes 300 units apart along X, in a folder called Blockout.”</li>' +
      '<li>“Find every point light and tell me its intensity.”</li>' +
      '</ul>',
  );
  transcript.appendChild(readyHintsEl);
}


// ------------------------------------------------------------------- sessions

/** Rebuilds the whole transcript from a session's saved entries. */
function replaySession(record: SessionRecord): void {
  session = record;
  transcript.innerHTML = '';
  toolCards.clear();
  currentModelBubble = null;
  onboardingEl = null;
  readyHintsEl = null;
  setRunning(false);

  for (const entry of record.entries) renderEntry(entry);

  renderUsage(record.usage);
  renderSessionBar();
  void refreshLinkedProject();
  updateOnboarding();
  scrollDown(true);
}

function renderEntry(entry: TranscriptEntry): void {
  switch (entry.kind) {
    case 'user':
      addUserMessage(entry.text);
      break;
    case 'text':
      addModelText(entry.text);
      break;
    case 'thought':
      addThought(entry.text);
      break;
    case 'tool':
      renderToolCard(entry.call);
      break;
    case 'notice':
      addNotice(entry.title, '<p>' + esc(entry.body) + '</p>', { error: entry.error });
      break;
  }
}

function renderSessionBar(): void {
  sessionTitleEl.textContent = session?.title ?? 'Session';
  const folder = session?.folderPath ?? null;
  if (folder) {
    // RTL on the chip keeps the tail of a long path visible, which is the useful part.
    folderLabel.textContent = folder;
    folderChip.classList.add('linked');
    folderChip.title = 'Open ' + folder + '  ·  click to change';
    unlinkFolderBtn.classList.remove('hidden');
  } else {
    folderLabel.textContent = 'Link a folder…';
    folderChip.classList.remove('linked');
    folderChip.title = 'Link a folder to this session';
    unlinkFolderBtn.classList.add('hidden');
  }
}

/** The launch button only earns its place when there is something to launch. */
function refreshLaunchButton(): void {
  const canLaunch = Boolean(linkedProjectInfo) && !mcp?.connected;
  launchEditorBtn.classList.toggle('hidden', !canLaunch);
  if (linkedProjectInfo) {
    launchEditorBtn.textContent = linkedProjectInfo.running
      ? 'Open ' + linkedProjectInfo.name
      : 'Start ' + linkedProjectInfo.name;
    launchEditorBtn.title = linkedProjectInfo.running
      ? linkedProjectInfo.name + ' is already running — bring it up and reconnect'
      : 'Launch ' + linkedProjectInfo.uprojectPath;
  }
}

async function refreshLinkedProject(): Promise<void> {
  linkedProjectInfo = await api.linkedProject();
  refreshLaunchButton();
}

async function refreshSessionList(): Promise<void> {
  const all = await api.listSessions();
  sessionList.innerHTML = '';

  for (const item of all) {
    const li = el('li', 'session-item' + (item.id === session?.id ? ' active' : ''));

    const main = el('div', 'si-main');
    const title = el('div', 'si-title');
    title.textContent = item.title;
    const meta = el('div', 'si-meta');
    meta.textContent =
      item.messageCount + (item.messageCount === 1 ? ' message' : ' messages') +
      ' · ' + new Date(item.updatedAt).toLocaleString();
    main.append(title, meta);
    if (item.folderPath) {
      const folder = el('div', 'si-meta si-folder');
      folder.textContent = item.folderPath;
      main.appendChild(folder);
    }

    const del = el('button', 'si-del');
    del.textContent = '🗑';
    del.title = 'Delete this session';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (item.messageCount > 0 && !confirm('Delete "' + item.title + '" and its transcript?')) return;
      replaySession(await api.deleteSession(item.id));
      await refreshSessionList();
    });

    li.append(main, del);
    li.addEventListener('click', async () => {
      if (item.id === session?.id) {
        sessionsOverlay.classList.add('hidden');
        return;
      }
      const opened = await api.openSession(item.id);
      if (opened) replaySession(opened);
      sessionsOverlay.classList.add('hidden');
      await refreshSessionList();
    });
    sessionList.appendChild(li);
  }
}

// ------------------------------------------------------------------- settings

function openSettings(): void {
  overlay.classList.remove('hidden');
  if (!credentials.hasKey) apiKeyInput.focus();
}

function closeSettingsDrawer(): void {
  overlay.classList.add('hidden');
  keyError.classList.add('hidden');
}

function applySettingsToForm(): void {
  thinkingLevel.value = settings.thinkingLevel;
  mcpUrlInput.value = settings.mcpUrl;
  requireApproval.checked = settings.requireApproval;
  maxSteps.value = String(settings.maxSteps);
  extraInstructions.value = settings.extraInstructions;
}

async function patch(p: Partial<AppSettings>): Promise<void> {
  settings = await api.updateSettings(p);
  modelPill.textContent = settings.model;
}

// ------------------------------------------------------------------ messaging

async function submit(): Promise<void> {
  const text = input.value.trim();
  if (!text || running) return;

  if (!credentials.hasKey) {
    addNotice(
      'No Gemini API key',
      '<p>Add a key in Settings before sending a message.</p>',
      { error: true, actions: [{ label: 'Open Settings', onClick: openSettings }] },
    );
    return;
  }

  input.value = '';
  resizeInput();
  readyHintsEl?.remove();
  readyHintsEl = null;
  addUserMessage(text);

  const res = await api.send(text);
  if (!res.ok) {
    addNotice('Could not send', '<p>' + esc(res.error ?? 'Unknown error.') + '</p>', { error: true });
  }
}

function resizeInput(): void {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 190) + 'px';
}

// ---------------------------------------------------------------------- events

function handleEvent(event: AgentEvent): void {
  switch (event.type) {
    case 'turn-start':
      setRunning(true);
      toolCards.clear();
      currentModelBubble = null;
      setStatus('Thinking…');
      break;

    case 'status':
      setStatus(event.text);
      break;

    case 'thought':
      addThought(event.text);
      break;

    case 'text':
      addModelText(event.text);
      break;

    case 'tool-call':
    case 'tool-update':
      renderToolCard(event.call);
      break;

    case 'approval-request':
      renderApproval(event.call);
      setStatus('Waiting for your approval…');
      break;

    case 'usage':
      renderUsage(event.usage);
      break;

    case 'turn-end':
      setRunning(false);
      break;

    case 'error':
      addNotice('Error', '<p>' + esc(event.message) + '</p>', { error: true });
      setRunning(false);
      break;

    case 'linked-project':
      linkedProjectInfo = event.project;
      refreshLaunchButton();
      break;

    case 'mcp-status':
      renderMcpStatus(event.status);
      console.log(
        '[mcp] ' +
          (event.status.connected
            ? 'connected, ' + event.status.toolsets.length + ' toolsets'
            : 'not connected: ' + (event.status.error ?? 'unknown')),
      );
      break;
  }
}

// -------------------------------------------------------------------- wiring

sendBtn.addEventListener('click', () => void submit());
stopBtn.addEventListener('click', () => void api.cancel());

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void submit();
  }
});
input.addEventListener('input', resizeInput);

settingsBtn.addEventListener('click', openSettings);
closeSettings.addEventListener('click', closeSettingsDrawer);
overlay.addEventListener('click', (e) => {
  if (e.target === overlay) closeSettingsDrawer();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeSettingsDrawer();
});

newChatBtn.addEventListener('click', async () => {
  replaySession(await api.createSession());
  await refreshSessionList();
  input.focus();
});

sessionsBtn.addEventListener('click', async () => {
  await refreshSessionList();
  sessionsOverlay.classList.remove('hidden');
});

closeSessionsBtn.addEventListener('click', () => sessionsOverlay.classList.add('hidden'));
sessionsOverlay.addEventListener('click', (e) => {
  if (e.target === sessionsOverlay) sessionsOverlay.classList.add('hidden');
});

newSessionBtn.addEventListener('click', async () => {
  replaySession(await api.createSession());
  await refreshSessionList();
  sessionsOverlay.classList.add('hidden');
  input.focus();
});

// Rename in place: the title doubles as its own editor.
sessionTitleEl.addEventListener('click', () => {
  if (!session) return;
  sessionTitleEl.contentEditable = 'plaintext-only';
  sessionTitleEl.focus();
  const range = document.createRange();
  range.selectNodeContents(sessionTitleEl);
  getSelection()?.removeAllRanges();
  getSelection()?.addRange(range);
});

sessionTitleEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sessionTitleEl.blur();
  } else if (e.key === 'Escape') {
    sessionTitleEl.textContent = session?.title ?? '';
    sessionTitleEl.blur();
  }
});

sessionTitleEl.addEventListener('blur', async () => {
  sessionTitleEl.contentEditable = 'false';
  const next = (sessionTitleEl.textContent ?? '').trim();
  if (!session || !next || next === session.title) {
    sessionTitleEl.textContent = session?.title ?? '';
    return;
  }
  const updated = await api.renameSession(session.id, next);
  if (updated) session = { ...session, title: updated.title };
  renderSessionBar();
});

folderChip.addEventListener('click', async () => {
  if (!session) return;
  const updated = await api.linkFolder(session.id);
  if (updated) {
    session = updated;
    renderSessionBar();
    await refreshLinkedProject();
  }
});

unlinkFolderBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!session) return;
  const updated = await api.unlinkFolder(session.id);
  if (updated) {
    session = updated;
    renderSessionBar();
    await refreshLinkedProject();
  }
});

launchEditorBtn.addEventListener('click', async () => {
  launchEditorBtn.disabled = true;
  const label = launchEditorBtn.textContent;
  launchEditorBtn.textContent = 'Starting…';
  try {
    const res = await api.launchEditor();
    if (!res.ok) {
      addNotice('Could not start the editor', '<p>' + esc(res.error ?? '') + '</p>', { error: true });
    } else {
      setStatus('Starting Unreal — it will connect on its own once the editor is up.');
    }
  } finally {
    launchEditorBtn.disabled = false;
    launchEditorBtn.textContent = label;
  }
});

mcpPill.addEventListener('click', async () => {
  mcpLabel.textContent = 'Connecting…';
  renderMcpStatus(await api.connectMcp(mcpUrlInput.value.trim() || settings.mcpUrl));
});

connectBtn.addEventListener('click', async () => {
  const url = mcpUrlInput.value.trim();
  connectBtn.disabled = true;
  connectBtn.textContent = 'Connecting…';
  try {
    renderMcpStatus(await api.connectMcp(url));
    settings = { ...settings, mcpUrl: url };
  } finally {
    connectBtn.disabled = false;
    connectBtn.textContent = 'Connect';
  }
});

saveKeyBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  keyError.classList.add('hidden');
  if (!key) {
    keyError.textContent = 'Paste a key first.';
    keyError.classList.remove('hidden');
    return;
  }

  saveKeyBtn.disabled = true;
  saveKeyBtn.textContent = 'Verifying…';
  try {
    const res = await api.setApiKey(key);
    if (!res.ok) {
      keyError.textContent = res.error ?? 'Could not verify the key.';
      keyError.classList.remove('hidden');
      return;
    }
    apiKeyInput.value = '';
    credentials = res.status ?? credentials;
    if (res.models?.length) models = res.models;
    renderCredentials();
    renderModelOptions();
    renderEncryptionNote(res.encryptionAvailable ?? credentials.encrypted);
  } finally {
    saveKeyBtn.disabled = false;
    saveKeyBtn.textContent = 'Verify & save';
  }
});

clearKeyBtn.addEventListener('click', async () => {
  credentials = await api.clearApiKey();
  renderCredentials();
});

getKeyLink.addEventListener('click', (e) => {
  e.preventDefault();
  void api.openExternal(getKeyLink.href);
});

refreshModelsBtn.addEventListener('click', async () => {
  refreshModelsBtn.disabled = true;
  refreshModelsBtn.textContent = '…';
  try {
    const res = await api.listModels();
    models = res.models;
    renderModelOptions();
    modelHelp.textContent = res.error ?? modelHelp.textContent;
  } finally {
    refreshModelsBtn.disabled = false;
    refreshModelsBtn.textContent = 'Refresh';
  }
});

modelSelect.addEventListener('change', () => void patch({ model: modelSelect.value }).then(renderModelOptions));
thinkingLevel.addEventListener('change', () =>
  patch({ thinkingLevel: thinkingLevel.value as ThinkingLevel }),
);
requireApproval.addEventListener('change', () => patch({ requireApproval: requireApproval.checked }));
maxSteps.addEventListener('change', () => {
  const n = Math.max(1, Math.min(200, Number(maxSteps.value) || 40));
  maxSteps.value = String(n);
  void patch({ maxSteps: n });
});
extraInstructions.addEventListener('change', () =>
  patch({ extraInstructions: extraInstructions.value }),
);
mcpUrlInput.addEventListener('change', () => patch({ mcpUrl: mcpUrlInput.value.trim() }));

function renderEncryptionNote(available: boolean): void {
  encNote.textContent = available
    ? 'Your API key is encrypted at rest with your Windows user account.'
    : 'The OS keychain is unavailable, so the key is kept in memory for this session only.';
}

// ---------------------------------------------------------------------- start

async function init(): Promise<void> {
  // Subscribe before anything slow, so a status event emitted while the main
  // process was still connecting to the editor is not dropped on the floor.
  api.onEvent(handleEvent);

  const boot = await api.bootstrap();
  settings = boot.settings;
  credentials = boot.credentials;
  mcp = boot.mcpStatus;

  applySettingsToForm();
  renderCredentials();
  renderMcpStatus(boot.mcpStatus);
  renderEncryptionNote(boot.encryptionAvailable);
  configPath.textContent = boot.configPath;
  renderUsage({ requests: 0, inputTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0 });

  if (credentials.hasKey) {
    const res = await api.listModels();
    models = res.models;
    // A failure here silently leaves only the built-in fallbacks in the picker.
    if (res.error) {
      console.error('[models] live list unavailable: ' + res.error);
      modelHelp.textContent = 'Using built-in model list — ' + res.error;
    }
  }
  renderModelOptions();

  if (boot.session) {
    replaySession(boot.session);
  } else {
    renderSessionBar();
  }

  // The window may have finished loading after the startup connect resolved, in
  // which case that event never reached us — pull the authoritative status now.
  renderMcpStatus(await api.mcpStatus());

  updateOnboarding();
  resizeInput();
  input.focus();
  console.log(
    '[init] ready — key=' + credentials.hasKey + ' editor=' + mcp.connected + ' models=' + models.length,
  );
}

window.addEventListener('error', (e) => console.error('[uncaught] ' + e.message));
window.addEventListener('unhandledrejection', (e) =>
  console.error('[unhandled] ' + String((e as PromiseRejectionEvent).reason)),
);

void init();
