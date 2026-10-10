/** Types shared between the Electron main process and the renderer UI. */

export interface AppSettings {
  /** Streamable-HTTP endpoint of the Unreal Editor MCP server. */
  mcpUrl: string;
  /** Gemini model id, e.g. "gemini-3.8-flash". */
  model: string;
  /** Ask before running any tool that can modify the project. */
  requireApproval: boolean;
  /**
   * Ask before commits and pushes. Separate from `requireApproval` because
   * pushing publishes code outside this machine and cannot be undone, so it
   * stays on even when editor changes are allowed to run freely.
   */
  requireGitApproval: boolean;
  /** Max model<->tool round trips for a single user message. */
  maxSteps: number;
  /** Extra text appended to the system instruction. */
  extraInstructions: string;
  /** "low" | "medium" | "high" — maps to generation_config.thinking_level. */
  thinkingLevel: ThinkingLevel;
}

export type ThinkingLevel = 'low' | 'medium' | 'high';

export interface CredentialStatus {
  /** A key is saved on disk. */
  hasKey: boolean;
  /** The key is protected by the OS keychain (DPAPI on Windows). */
  encrypted: boolean;
  /** Last 4 characters of the saved key, for display only. */
  hint: string | null;
  /** A key was stored but can no longer be decrypted; it has been cleared. */
  stale: boolean;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  description: string;
  inputTokenLimit: number;
  outputTokenLimit: number;
}

/** Git branch state of the session's linked folder, for the session bar. */
export interface BranchState {
  isRepo: boolean;
  current: string | null;
  branches: string[];
  dirty: boolean;
}

export interface LinkedProject {
  /** Absolute path to the .uproject found in the session's linked folder. */
  uprojectPath: string;
  name: string;
  engineAssociation: string | null;
  /** True when an editor is running with this exact project open. */
  running: boolean;
}

export interface McpStatus {
  connected: boolean;
  url: string;
  /** Names of the tools the server exposes at the top level. */
  tools: string[];
  /** Names of the Unreal toolsets discovered through list_toolsets. */
  toolsets: string[];
  error: string | null;
  /** Set when the connected editor has a different project open than the one linked. */
  projectMismatch: string | null;
  /** True while the supervisor is retrying in the background. */
  waiting: boolean;
}

export type ToolRisk = 'read' | 'write';

export interface ToolCallRecord {
  id: string;
  /** Unreal toolset, when the call targets one. */
  toolsetName: string | null;
  toolName: string;
  /** Fully qualified label for display. */
  label: string;
  args: unknown;
  risk: ToolRisk;
  status: 'pending' | 'awaiting-approval' | 'running' | 'ok' | 'error' | 'denied';
  result: string | null;
  error: string | null;
  durationMs: number | null;
}

export interface UsageTotals {
  /** API requests made. On the free tier this, not tokens, is the binding limit. */
  requests: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  totalTokens: number;
}

/** Events pushed from main -> renderer while a turn is running. */
export type AgentEvent =
  | { type: 'turn-start'; turnId: string }
  | { type: 'status'; text: string }
  | { type: 'thought'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool-call'; call: ToolCallRecord }
  | { type: 'tool-update'; call: ToolCallRecord }
  | { type: 'approval-request'; call: ToolCallRecord }
  | { type: 'usage'; usage: UsageTotals }
  | { type: 'turn-end'; turnId: string; stoppedEarly: boolean }
  | { type: 'error'; message: string }
  | { type: 'mcp-status'; status: McpStatus }
  | { type: 'linked-project'; project: LinkedProject | null }
  | { type: 'branch-info'; info: BranchState };

export interface ApprovalDecision {
  callId: string;
  approved: boolean;
  /** Approve every remaining write for this session. */
  always: boolean;
}

/** One saved conversation, with its own folder, transcript and Gemini thread. */
export interface SessionSummary {
  id: string;
  title: string;
  /** Absolute path to the folder linked to this session, if any. */
  folderPath: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

/** A replayable transcript entry. The renderer rebuilds the view from these. */
export type TranscriptEntry =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'thought'; text: string }
  | { kind: 'tool'; call: ToolCallRecord }
  | { kind: 'notice'; title: string; body: string; error: boolean };

export interface SessionRecord extends SessionSummary {
  /** Lets a reopened session continue the same Gemini thread. */
  previousInteractionId: string | null;
  usage: UsageTotals;
  entries: TranscriptEntry[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  mcpUrl: 'http://127.0.0.1:8000/mcp',
  model: 'gemini-3.8-flash',
  requireApproval: false,
  requireGitApproval: true,
  maxSteps: 40,
  extraInstructions: '',
  thinkingLevel: 'high',
};

/** Models known good for tool use, offered when the live list cannot be fetched. */
export const FALLBACK_MODELS: ModelInfo[] = [
  {
    id: 'gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash',
    description: 'Fast and inexpensive. Good default for editor automation.',
    inputTokenLimit: 0,
    outputTokenLimit: 0,
  },
  {
    id: 'gemini-3.1-pro-preview',
    displayName: 'Gemini 3.1 Pro (preview)',
    description: 'Strongest reasoning. Better for multi-step scene construction.',
    inputTokenLimit: 0,
    outputTokenLimit: 0,
  },
];
