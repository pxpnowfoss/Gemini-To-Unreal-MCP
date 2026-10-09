/**
 * Electron main process: owns the window, the credentials, the MCP connection and
 * the agent loop. The renderer holds no secrets and talks to all of this over IPC.
 */

import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { Store } from './store';
import { McpClient } from './mcpClient';
import { GeminiClient, GeminiError } from './geminiClient';
import { Agent } from './agent';
import { SessionStore, toSummary } from './sessionStore';
import { EditorSupervisor } from './editorSupervisor';
import { findProject, runningEditorProjects, samePath, projectExists } from './projectLocator';
import type { ProjectInfo } from './projectLocator';
import { FALLBACK_MODELS } from '../shared/types';
import type {
  AgentEvent,
  AppSettings,
  McpStatus,
  ModelInfo,
  SessionRecord,
  SessionSummary,
  LinkedProject,
} from '../shared/types';

let win: BrowserWindow | null = null;
let store: Store;
let mcp: McpClient;
let gemini: GeminiClient;
let agent: Agent;
let sessions: SessionStore;
let supervisor: EditorSupervisor;

let mcpStatus: McpStatus = {
  connected: false,
  url: '',
  tools: [],
  toolsets: [],
  error: null,
  projectMismatch: null,
  waiting: false,
};

function send(event: AgentEvent): void {
  recordEvent(event);
  if (win && !win.isDestroyed()) win.webContents.send('agent:event', event);
}

/** Mirrors the live transcript into the active session so it survives a restart. */
function recordEvent(event: AgentEvent): void {
  if (!sessions?.current) return;
  switch (event.type) {
    case 'text':
      sessions.append({ kind: 'text', text: event.text });
      break;
    case 'thought':
      sessions.append({ kind: 'thought', text: event.text });
      break;
    case 'tool-call':
    case 'tool-update':
    case 'approval-request':
      sessions.append({ kind: 'tool', call: event.call });
      break;
    case 'error':
      sessions.append({ kind: 'notice', title: 'Error', body: event.message, error: true });
      break;
    case 'usage':
      sessions.setUsage(event.usage);
      break;
    case 'turn-end':
      sessions.setInteractionId(agent.conversationId);
      sessions.flush();
      break;
  }
}

/**
 * Reports the project linked to the active session, and whether an editor is
 * already running with it.
 */
async function linkedProject(): Promise<LinkedProject | null> {
  const info = findProject(sessions?.current?.folderPath ?? null);
  if (!projectExists(info)) return null;
  const running = (await runningEditorProjects()).some((p) => samePath(p, info!.uprojectPath));
  return {
    uprojectPath: info!.uprojectPath,
    name: info!.name,
    engineAssociation: info!.engineAssociation,
    running,
  };
}

/**
 * Warns when the editor we are talking to is not the project the session is
 * linked to — otherwise Gemini would happily build in the wrong project.
 */
async function detectMismatch(): Promise<string | null> {
  const info = findProject(sessions?.current?.folderPath ?? null);
  if (!projectExists(info)) return null;

  const open = await runningEditorProjects();
  if (!open.length) return null;
  if (open.some((p) => samePath(p, info!.uprojectPath))) return null;

  const names = open.map((p) => p.split(/[\\/]/).pop()?.replace(/\.uproject$/i, '') ?? p);
  return (
    'The connected editor has ' +
    names.join(', ') +
    ' open, but this session is linked to ' +
    info!.name +
    '.'
  );
}

/** Points the agent at a session's conversation state and linked folder. */
function activate(record: SessionRecord): SessionRecord {
  agent.cancel();
  agent.restore(record.previousInteractionId, record.usage);
  agent.folderPath = record.folderPath;
  void linkedProject().then((project) => send({ type: 'linked-project', project }));
  return record;
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1180,
    height: 840,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#14161a',
    title: 'Gemini → Unreal',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => win?.show());
  win.loadFile(join(__dirname, '../renderer/renderer/index.html'));

  // Keep navigation inside the app; open real links in the user's browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  // Surface renderer and preload failures on the terminal — otherwise a typo in the
  // UI fails silently inside the window.
  win.webContents.on('preload-error', (_e, path, error) => {
    console.error('[preload] ' + path + ': ' + error.message);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[renderer] failed to load ' + url + ' (' + code + ' ' + desc + ')');
  });
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning' || process.argv.includes('--dev')) {
      console.error('[renderer:' + event.level + '] ' + event.message);
    }
  });

  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

/** Opens the MCP session and discovers the toolsets, updating the cached status. */
async function connectMcp(url?: string): Promise<McpStatus> {
  if (url) {
    mcp.setUrl(url);
    store.updateSettings({ mcpUrl: url });
  }

  mcpStatus = { connected: false, url: mcp.endpoint, tools: [], toolsets: [], error: null, projectMismatch: null, waiting: false };

  try {
    await mcp.connect();
    const tools = await mcp.listTools();

    let toolsets: string[] = [];
    if (tools.some((t) => t.name === 'list_toolsets')) {
      try {
        const res = await mcp.callTool('list_toolsets', {});
        toolsets = parseToolsetNames(res.text);
      } catch {
        // A server without the meta-tools still works; just no toolset list.
      }
    }

    mcpStatus = {
      connected: true,
      url: mcp.endpoint,
      tools: tools.map((t) => t.name),
      toolsets,
      error: null,
      projectMismatch: await detectMismatch(),
      waiting: false,
    };
  } catch (err) {
    mcpStatus = {
      connected: false,
      url: mcp.endpoint,
      tools: [],
      toolsets: [],
      error: (err as Error).message,
      projectMismatch: null,
      waiting: true,
    };
  }

  send({ type: 'mcp-status', status: mcpStatus });
  return mcpStatus;
}

/**
 * `list_toolsets` returns prose ("- name: description" per line) rather than JSON,
 * so we pull the names out with a light parse and fall back to raw lines.
 */
function parseToolsetNames(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*[-*]?\s*([A-Za-z_][\w.]*(?:\.[A-Za-z_]\w*)+)\s*:/.exec(line);
    if (match && match[1]) names.push(match[1]);
  }
  return names;
}

function requireKey(): string {
  const key = store.getApiKey();
  if (!key) {
    throw new Error('No Gemini API key saved. Add one in Settings to get started.');
  }
  gemini.setApiKey(key);
  return key;
}

function registerIpc(): void {
  ipcMain.handle('app:bootstrap', () => ({
    settings: store.settings,
    credentials: store.credentialStatus(),
    encryptionAvailable: store.encryptionAvailable(),
    configPath: store.configPath,
    mcpStatus,
    version: app.getVersion(),
    session: sessions.current,
    sessions: sessions.list(),
  }));

  ipcMain.handle('settings:update', (_e, patch: Partial<AppSettings>) => {
    const next = store.updateSettings(patch);
    if (patch.mcpUrl && patch.mcpUrl !== mcp.endpoint) mcp.setUrl(patch.mcpUrl);
    return next;
  });

  ipcMain.handle('credentials:set', async (_e, key: string) => {
    const trimmed = (key ?? '').trim();
    if (!trimmed) return { ok: false, error: 'Enter a key first.' };

    // Validate before saving, so a typo never gets stored as "configured".
    const probe = new GeminiClient(trimmed);
    try {
      const models = await probe.listModels();
      const status = store.setApiKey(trimmed);
      gemini.setApiKey(trimmed);
      return { ok: true, status, models, encryptionAvailable: store.encryptionAvailable() };
    } catch (err) {
      const message =
        err instanceof GeminiError ? err.message : 'Could not verify the key: ' + (err as Error).message;
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('credentials:clear', () => {
    agent.resetConversation();
    return store.clearApiKey();
  });

  ipcMain.handle('models:list', async (): Promise<{ models: ModelInfo[]; error: string | null }> => {
    try {
      requireKey();
      return { models: await gemini.listModels(), error: null };
    } catch (err) {
      return { models: FALLBACK_MODELS, error: (err as Error).message };
    }
  });

  ipcMain.handle('mcp:connect', async (_e, url?: string) => {
    const status = await connectMcp(url);
    supervisor?.setConnected(status.connected);
    return status;
  });
  ipcMain.handle('mcp:status', () => mcpStatus);
  ipcMain.handle('mcp:disconnect', async () => {
    supervisor?.stop();
    await mcp.close();
    mcpStatus = { connected: false, url: mcp.endpoint, tools: [], toolsets: [], error: null, projectMismatch: null, waiting: false };
    send({ type: 'mcp-status', status: mcpStatus });
    return mcpStatus;
  });

  ipcMain.handle('chat:send', async (_e, text: string) => {
    if (agent.running) return { ok: false, error: 'Still working on the previous message.' };
    try {
      requireKey();
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    sessions.append({ kind: 'user', text });
    // Deliberately not awaited: events stream to the renderer while this runs.
    void agent.send(text, store.settings);
    return { ok: true };
  });

  ipcMain.handle('chat:cancel', () => {
    agent.cancel();
    return { ok: true };
  });

  ipcMain.handle('chat:reset', () => {
    agent.cancel();
    agent.resetConversation();
    return { ok: true };
  });

  ipcMain.handle('approval:resolve', (_e, callId: string, approved: boolean, always: boolean) => {
    agent.resolveApproval(callId, approved, always);
    return { ok: true };
  });

  ipcMain.handle('editor:project', (): Promise<LinkedProject | null> => linkedProject());

  /**
   * Opens the linked project. Launching the .uproject through the shell lets
   * Unreal's own version selector pick the matching engine build, which is far
   * more reliable than guessing an engine path from EngineAssociation.
   */
  ipcMain.handle('editor:launch', async (): Promise<{ ok: boolean; error?: string }> => {
    const project = await linkedProject();
    if (!project) {
      return { ok: false, error: 'No .uproject found in the folder linked to this session.' };
    }
    if (project.running) {
      // Already open: nothing to launch, just keep trying to connect.
      supervisor.setConnected(false);
      return { ok: true };
    }
    const problem = await shell.openPath(project.uprojectPath);
    if (problem) return { ok: false, error: problem };
    // The editor takes a while to come up; the supervisor will catch it.
    supervisor.setConnected(false);
    return { ok: true };
  });

  ipcMain.handle('sessions:list', (): SessionSummary[] => sessions.list());

  ipcMain.handle('sessions:current', (): SessionRecord | null => sessions.current);

  ipcMain.handle('sessions:create', (): SessionRecord => activate(sessions.create()));

  ipcMain.handle('sessions:open', (_e, id: string): SessionRecord | null => {
    const record = sessions.load(id);
    return record ? activate(record) : null;
  });

  ipcMain.handle('sessions:rename', (_e, id: string, title: string) => sessions.rename(id, title));

  ipcMain.handle('sessions:delete', (_e, id: string): SessionRecord => {
    sessions.delete(id);
    // Always leave exactly one session open, so the UI never has nothing to show.
    const [next] = sessions.list();
    const record = (next && sessions.load(next.id)) || sessions.create();
    return activate(record);
  });

  /** Opens a native folder picker and links the chosen folder to the session. */
  ipcMain.handle('sessions:linkFolder', async (_e, id: string): Promise<SessionRecord | null> => {
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      title: 'Link a folder to this session',
      properties: ['openDirectory'],
      defaultPath: sessions.current?.folderPath ?? undefined,
    });
    if (result.canceled || !result.filePaths.length) return sessions.current;
    const record = sessions.setFolder(id, result.filePaths[0]);
    if (record && sessions.current?.id === id) agent.folderPath = record.folderPath;
    return record;
  });

  ipcMain.handle('sessions:unlinkFolder', (_e, id: string): SessionRecord | null => {
    const record = sessions.setFolder(id, null);
    if (record && sessions.current?.id === id) agent.folderPath = null;
    return record;
  });

  ipcMain.handle('sessions:revealFolder', (_e, folderPath: string) => {
    if (folderPath) void shell.openPath(folderPath);
    return { ok: true };
  });

  ipcMain.handle('shell:open', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { ok: true };
  });
}

/**
 * Only one instance may own this profile. Two Electron processes sharing a
 * userData directory contend over Chromium's `Local State`, which is where
 * safeStorage keeps its AES key — the practical symptom is that a perfectly good
 * saved credential suddenly fails to decrypt.
 */
const gotLock = app.requestSingleInstanceLock();
const isDiagnostic = process.argv.some((a) => a.startsWith('--diagnose') || a.startsWith('--crypto'));

if (!gotLock) {
  if (isDiagnostic) {
    console.error(
      'Another instance of Gemini → Unreal is already running.\n' +
        'Close it before running diagnostics — a second instance sharing the profile\n' +
        'can make a saved API key fail to decrypt.',
    );
  }
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

app.whenReady().then(async () => {
  if (!gotLock) return;
  store = new Store();
  mcp = new McpClient(store.settings.mcpUrl);
  gemini = new GeminiClient(store.getApiKey() ?? '');
  agent = new Agent(gemini, mcp, send);

  // `--crypto-roundtrip <write|read>` proves whether safeStorage survives a restart
  // on this machine. Used to tell "stale blob" apart from "encryption is broken".
  if (process.argv.includes('--crypto-roundtrip')) {
    const { safeStorage } = require('electron') as typeof import('electron');
    const mode = process.argv[process.argv.indexOf('--crypto-roundtrip') + 1] ?? 'write';
    const probe = join(app.getPath('userData'), 'crypto-probe.bin');
    const SENTINEL = 'sentinel-value-12345';
    try {
      if (mode === 'write') {
        writeFileSync(probe, safeStorage.encryptString(SENTINEL));
        console.log('WROTE probe (' + statSync(probe).size + ' bytes)');
      } else {
        const out = safeStorage.decryptString(readFileSync(probe));
        console.log('READ  probe -> ' + (out === SENTINEL ? 'MATCH (round trip OK)' : 'MISMATCH: ' + out));
      }
    } catch (err) {
      console.log(mode.toUpperCase() + ' FAILED: ' + (err as Error).message);
    }
    app.quit();
    return;
  }

  // `--diagnose-sessions` round-trips a session through disk and exits, proving that
  // a transcript, a linked folder and the Gemini thread id survive a restart.
  if (process.argv.includes('--diagnose-sessions')) {
    const probe = new SessionStore();
    const before = probe.list().length;

    const made = probe.create('Persistence probe', app.getAppPath());
    probe.append({ kind: 'user', text: 'place a red cube in L_Main' });
    probe.append({ kind: 'text', text: 'Done.' });
    probe.setInteractionId('int_probe_123');
    probe.setUsage({ requests: 7, inputTokens: 10, outputTokens: 2, thoughtTokens: 1, totalTokens: 13 });
    probe.flush();

    // A fresh store reads purely from disk — no in-memory cheating.
    const reread = new SessionStore();
    const back = reread.load(made.id);
    const listed = reread.list();

    console.log('sessions before      : ' + before);
    console.log('created id           : ' + made.id);
    console.log('reloaded from disk   : ' + Boolean(back));
    console.log('title (auto-named)   : ' + back?.title);
    console.log('folderPath kept      : ' + back?.folderPath);
    console.log('entries kept         : ' + back?.entries.length);
    console.log('gemini thread kept   : ' + back?.previousInteractionId);
    console.log('usage.requests kept  : ' + back?.usage.requests);
    console.log('appears in list()    : ' + listed.some((x) => x.id === made.id));
    console.log('remembered as active : ' + (new SessionStore().openInitial().id === made.id));

    reread.delete(made.id);
    console.log('deleted cleanly      : ' + !new SessionStore().list().some((x) => x.id === made.id));

    app.quit();
    return;
  }

  // `--diagnose-credentials` prints why a saved key is or is not usable, then exits.
  // It must run inside the real app because safeStorage is scoped to its identity.
  if (process.argv.includes('--diagnose-credentials')) {
    const status = store.credentialStatus();
    const key = store.getApiKey();
    console.log('userData            : ' + app.getPath('userData'));
    console.log('config              : ' + store.configPath);
    console.log('encryptionAvailable : ' + store.encryptionAvailable());
    console.log('status.hasKey       : ' + status.hasKey);
    console.log('status.encrypted    : ' + status.encrypted);
    console.log('getApiKey() usable  : ' + Boolean(key) + (key ? ' (length ' + key.length + ')' : ''));

    if (!key && status.encrypted) {
      const { safeStorage } = require('electron') as typeof import('electron');
      const raw = JSON.parse(readFileSync(store.configPath, 'utf8')) as { apiKeyEnc?: string };
      const buf = Buffer.from(raw.apiKeyEnc ?? '', 'base64');
      console.log('ciphertext bytes    : ' + buf.length);
      console.log('ciphertext prefix   : ' + JSON.stringify(buf.subarray(0, 3).toString('latin1')));
      try {
        const out = safeStorage.decryptString(buf);
        console.log('decrypt succeeded   : length ' + out.length + ', empty=' + (out.length === 0));
      } catch (err) {
        console.log('decrypt threw       : ' + (err as Error).message);
      }
    }

    app.quit();
    return;
  }

  sessions = new SessionStore();
  activate(sessions.openInitial());

  registerIpc();
  createWindow();

  // The editor comes and goes; watch for it rather than trying once at startup.
  supervisor = new EditorSupervisor({
    tryConnect: async () => {
      const status = await connectMcp();
      return status.connected;
    },
    probe: async () => {
      try {
        await mcp.listTools();
        return true;
      } catch {
        return false;
      }
    },
    isBusy: () => agent.running,
    onLost: () => {
      mcpStatus = {
        connected: false,
        url: mcp.endpoint,
        tools: [],
        toolsets: [],
        error: 'The editor closed.',
        projectMismatch: null,
        waiting: true,
      };
      send({ type: 'mcp-status', status: mcpStatus });
    },
  });
  supervisor.start();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  supervisor?.stop();
  sessions?.flush();
  void mcp?.close();
  if (process.platform !== 'darwin') app.quit();
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  send({ type: 'error', message: 'Unexpected error: ' + message });
});

process.on('uncaughtException', (err) => {
  if (win && !win.isDestroyed()) {
    void dialog.showMessageBox(win, {
      type: 'error',
      message: 'Something went wrong',
      detail: err.message,
    });
  }
});
