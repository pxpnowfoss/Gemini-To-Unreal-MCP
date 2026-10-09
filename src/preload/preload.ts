/**
 * The only bridge between the renderer and Node. Everything is an explicit,
 * narrow call — the renderer never sees `ipcRenderer`, the filesystem or the key.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type {
  AgentEvent,
  AppSettings,
  CredentialStatus,
  McpStatus,
  ModelInfo,
  SessionRecord,
  SessionSummary,
  LinkedProject,
} from '../shared/types';

export interface Bootstrap {
  settings: AppSettings;
  credentials: CredentialStatus;
  encryptionAvailable: boolean;
  configPath: string;
  mcpStatus: McpStatus;
  version: string;
  session: SessionRecord | null;
  sessions: SessionSummary[];
}

export interface SetKeyResult {
  ok: boolean;
  error?: string;
  status?: CredentialStatus;
  models?: ModelInfo[];
  encryptionAvailable?: boolean;
}

const api = {
  bootstrap: (): Promise<Bootstrap> => ipcRenderer.invoke('app:bootstrap'),

  updateSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:update', patch),

  setApiKey: (key: string): Promise<SetKeyResult> => ipcRenderer.invoke('credentials:set', key),
  clearApiKey: (): Promise<CredentialStatus> => ipcRenderer.invoke('credentials:clear'),

  listModels: (): Promise<{ models: ModelInfo[]; error: string | null }> =>
    ipcRenderer.invoke('models:list'),

  connectMcp: (url?: string): Promise<McpStatus> => ipcRenderer.invoke('mcp:connect', url),
  mcpStatus: (): Promise<McpStatus> => ipcRenderer.invoke('mcp:status'),
  disconnectMcp: (): Promise<McpStatus> => ipcRenderer.invoke('mcp:disconnect'),

  send: (text: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('chat:send', text),
  cancel: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('chat:cancel'),
  resetConversation: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('chat:reset'),

  resolveApproval: (callId: string, approved: boolean, always: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('approval:resolve', callId, approved, always),

  openExternal: (url: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('shell:open', url),

  linkedProject: (): Promise<LinkedProject | null> => ipcRenderer.invoke('editor:project'),
  launchEditor: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('editor:launch'),

  listSessions: (): Promise<SessionSummary[]> => ipcRenderer.invoke('sessions:list'),
  currentSession: (): Promise<SessionRecord | null> => ipcRenderer.invoke('sessions:current'),
  createSession: (): Promise<SessionRecord> => ipcRenderer.invoke('sessions:create'),
  openSession: (id: string): Promise<SessionRecord | null> =>
    ipcRenderer.invoke('sessions:open', id),
  renameSession: (id: string, title: string): Promise<SessionRecord | null> =>
    ipcRenderer.invoke('sessions:rename', id, title),
  deleteSession: (id: string): Promise<SessionRecord> => ipcRenderer.invoke('sessions:delete', id),
  linkFolder: (id: string): Promise<SessionRecord | null> =>
    ipcRenderer.invoke('sessions:linkFolder', id),
  unlinkFolder: (id: string): Promise<SessionRecord | null> =>
    ipcRenderer.invoke('sessions:unlinkFolder', id),
  revealFolder: (folderPath: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('sessions:revealFolder', folderPath),

  onEvent: (handler: (event: AgentEvent) => void): (() => void) => {
    const listener = (_e: unknown, payload: AgentEvent) => handler(payload);
    ipcRenderer.on('agent:event', listener);
    return () => ipcRenderer.removeListener('agent:event', listener);
  },
};

contextBridge.exposeInMainWorld('api', api);

export type RendererApi = typeof api;
