/**
 * The agent loop.
 *
 * One user message can take many model<->tool round trips: Gemini discovers the
 * toolsets it needs, reads their schemas, then issues editor calls. Each iteration
 * posts to the Interactions API, runs whatever tools come back, and feeds the
 * results in as `function_result` steps until the interaction reaches a terminal
 * status or we hit the configured step ceiling.
 */

import { randomUUID } from 'node:crypto';
import {
  GeminiClient,
  GeminiError,
  extractFunctionCalls,
  extractText,
  extractThoughts,
  formatDuration,
} from './geminiClient';
import type { FunctionResultStep, Interaction } from './geminiClient';
import { McpClient } from './mcpClient';
import {
  TOOL_CALL_TOOL,
  TOOL_DESCRIBE_TOOLSET,
  TOOL_LIST_TOOLSETS,
  buildFunctionDeclarations,
  buildSystemInstruction,
  classifyRisk,
  parseArgumentsJson,
} from './toolBridge';
import { runGitTool } from './gitTools';
import type { AgentEvent, AppSettings, ToolCallRecord, UsageTotals } from '../shared/types';

/** Tool output longer than this is truncated before going back to the model. */
const MAX_RESULT_CHARS = 60_000;

type Emit = (event: AgentEvent) => void;

interface PendingApproval {
  resolve: (decision: { approved: boolean; always: boolean }) => void;
}

export class Agent {
  private previousInteractionId: string | null = null;
  private abort: AbortController | null = null;
  private pending = new Map<string, PendingApproval>();
  private approveAll = false;
  /** Tracked separately so approving editor writes never implies approving pushes. */
  private approveAllGit = false;
  private usage: UsageTotals = { requests: 0, inputTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0 };

  /** Folder linked to the active session, surfaced to the model as context. */
  folderPath: string | null = null;

  constructor(
    private gemini: GeminiClient,
    private mcp: McpClient,
    private emit: Emit,
  ) {}

  get running(): boolean {
    return this.abort !== null;
  }

  /** The Gemini thread id, so a session can resume where it left off. */
  get conversationId(): string | null {
    return this.previousInteractionId;
  }

  get usageTotals(): UsageTotals {
    return { ...this.usage };
  }

  /** Adopts a saved session's conversation state when switching sessions. */
  restore(previousInteractionId: string | null, usage: UsageTotals): void {
    this.previousInteractionId = previousInteractionId;
    this.usage = { ...usage };
    this.approveAll = false;
    this.approveAllGit = false;
    this.emit({ type: 'usage', usage: { ...this.usage } });
  }

  /** Forgets the server-side conversation so the next message starts fresh. */
  resetConversation(): void {
    this.previousInteractionId = null;
    this.approveAll = false;
    this.approveAllGit = false;
    this.usage = { requests: 0, inputTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0 };
  }

  cancel(): void {
    this.abort?.abort();
    // Unblock anything waiting on the user so the loop can unwind.
    for (const [, p] of this.pending) p.resolve({ approved: false, always: false });
    this.pending.clear();
  }

  resolveApproval(callId: string, approved: boolean, always: boolean): void {
    const entry = this.pending.get(callId);
    if (!entry) return;
    this.pending.delete(callId);
    if (approved && always) this.approveAll = true;
    entry.resolve({ approved, always });
  }

  async send(userText: string, settings: AppSettings): Promise<void> {
    if (this.abort) throw new Error('A turn is already running.');

    const turnId = randomUUID();
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const tools = buildFunctionDeclarations();
    const systemInstruction = buildSystemInstruction(settings.extraInstructions, this.folderPath);

    // Let the user see a backoff as progress, not a freeze.
    this.gemini.onRetry = (info) => {
      this.emit({
        type: 'status',
        text:
          'Gemini ' + info.reason + ' — retrying in ' +
          formatDuration(info.waitMs) + ' (' + info.attempt + '/' + info.max + ')',
      });
    };

    this.emit({ type: 'turn-start', turnId });

    let stoppedEarly = false;

    try {
      await this.mcp.connect();

      let input: string | FunctionResultStep[] = userText;
      let steps = 0;

      while (true) {
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');

        if (steps >= settings.maxSteps) {
          stoppedEarly = true;
          this.emit({
            type: 'text',
            text:
              '_Stopped after ' +
              settings.maxSteps +
              ' tool steps. Send another message to continue from here._',
          });
          break;
        }
        steps++;

        this.emit({
          type: 'status',
          text: steps === 1 ? 'Thinking…' : 'Step ' + steps + ' · thinking…',
        });

        this.usage = { ...this.usage, requests: this.usage.requests + 1 };

        const interaction: Interaction = await this.gemini.createInteraction({
          model: settings.model,
          input,
          tools,
          systemInstruction,
          previousInteractionId: this.previousInteractionId,
          thinkingLevel: settings.thinkingLevel,
          signal,
        });

        this.previousInteractionId = interaction.id;
        this.accumulateUsage(interaction);

        for (const thought of extractThoughts(interaction)) {
          this.emit({ type: 'thought', text: thought });
        }

        const text = extractText(interaction);
        if (text) this.emit({ type: 'text', text });

        if (interaction.status === 'failed' || interaction.status === 'cancelled') {
          const detail = interaction.errors ? JSON.stringify(interaction.errors) : interaction.status;
          throw new Error('Gemini ended the interaction: ' + detail);
        }

        if (interaction.status !== 'requires_action') break;

        const calls = extractFunctionCalls(interaction);
        if (!calls.length) break;

        const results: FunctionResultStep[] = [];
        for (const call of calls) {
          if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
          results.push(await this.runOneCall(call, settings));
        }

        input = results;
      }
    } catch (err) {
      const e = err as Error;
      if (e.name === 'AbortError') {
        this.emit({ type: 'status', text: 'Cancelled.' });
      } else if (e instanceof GeminiError) {
        this.emit({ type: 'error', message: e.message });
      } else {
        this.emit({ type: 'error', message: e.message || String(err) });
      }
    } finally {
      this.gemini.onRetry = null;
      this.abort = null;
      this.pending.clear();
      this.emit({ type: 'usage', usage: { ...this.usage } });
      this.emit({ type: 'turn-end', turnId, stoppedEarly });
    }
  }

  /** Resolves one Gemini function call against the Unreal MCP server. */
  private async runOneCall(
    call: { id: string; name: string; arguments: unknown },
    settings: AppSettings,
  ): Promise<FunctionResultStep> {
    const started = Date.now();

    const rawArgs =
      typeof call.arguments === 'string'
        ? safeParse(call.arguments)
        : (call.arguments as Record<string, unknown> | undefined) ?? {};

    // Git tools run locally against the session's linked folder, not the editor.
    if (call.name.startsWith('git_')) {
      return this.runGitCall(call, rawArgs, settings, started);
    }

    let toolsetName: string | null = null;
    let unrealTool: string;
    let unrealArgs: Record<string, unknown> = {};
    let argError: string | null = null;

    switch (call.name) {
      case TOOL_LIST_TOOLSETS:
        unrealTool = 'list_toolsets';
        break;

      case TOOL_DESCRIBE_TOOLSET: {
        unrealTool = 'describe_toolset';
        const name = rawArgs?.['toolset_name'];
        if (typeof name !== 'string' || !name.trim()) {
          argError = 'describe_toolset needs a `toolset_name` string.';
        } else {
          unrealArgs = { toolset_name: name.trim() };
        }
        break;
      }

      case TOOL_CALL_TOOL: {
        const ts = rawArgs?.['toolset_name'];
        const tn = rawArgs?.['tool_name'];
        if (typeof tn !== 'string' || !tn.trim()) {
          unrealTool = 'call_tool';
          argError = 'call_tool needs a `tool_name` string.';
          break;
        }
        toolsetName = typeof ts === 'string' && ts.trim() ? ts.trim() : null;
        // The model is told to send the bare name, but it sometimes sends the
        // fully-qualified one. Strip the prefix so both work.
        unrealTool = stripToolsetPrefix(tn.trim(), toolsetName);

        const parsed = parseArgumentsJson(rawArgs?.['arguments_json']);
        if (!parsed.ok) {
          argError = parsed.error;
        } else {
          unrealArgs = {
            ...(toolsetName ? { toolset_name: toolsetName } : {}),
            tool_name: unrealTool,
            arguments: parsed.args,
          };
        }
        break;
      }

      default:
        return this.errorResult(call, 'Unknown tool "' + call.name + '".');
    }

    const innerArgs =
      call.name === TOOL_CALL_TOOL ? ((unrealArgs['arguments'] as Record<string, unknown>) ?? {}) : unrealArgs;

    const record: ToolCallRecord = {
      id: call.id || randomUUID(),
      toolsetName,
      toolName: unrealTool,
      label: toolsetName ? shortToolsetName(toolsetName) + '.' + unrealTool : unrealTool,
      args: innerArgs,
      risk: call.name === TOOL_CALL_TOOL ? classifyRisk(unrealTool) : 'read',
      status: 'pending',
      result: null,
      error: null,
      durationMs: null,
    };

    this.emit({ type: 'tool-call', call: record });

    if (argError) {
      record.status = 'error';
      record.error = argError;
      record.durationMs = Date.now() - started;
      this.emit({ type: 'tool-update', call: { ...record } });
      return this.errorResult(call, argError);
    }

    // Gate writes behind the user when the setting is on.
    if (settings.requireApproval && record.risk === 'write' && !this.approveAll) {
      record.status = 'awaiting-approval';
      this.emit({ type: 'approval-request', call: { ...record } });

      const decision = await new Promise<{ approved: boolean; always: boolean }>((resolve) => {
        this.pending.set(record.id, { resolve });
      });

      if (!decision.approved) {
        record.status = 'denied';
        record.error = 'Declined by the user.';
        record.durationMs = Date.now() - started;
        this.emit({ type: 'tool-update', call: { ...record } });
        return {
          type: 'function_result',
          name: call.name,
          call_id: call.id,
          result: [
            {
              type: 'text',
              text:
                'The user declined this call. Do not retry it. Ask what they would prefer, ' +
                'or continue with the parts of the task that do not need it.',
            },
          ],
        };
      }
    }

    record.status = 'running';
    this.emit({ type: 'tool-update', call: { ...record } });

    // The outer MCP tool is always one of the three meta-tools.
    const metaTool =
      call.name === TOOL_LIST_TOOLSETS
        ? 'list_toolsets'
        : call.name === TOOL_DESCRIBE_TOOLSET
          ? 'describe_toolset'
          : 'call_tool';

    try {
      const result = await this.mcp.callTool(metaTool, unrealArgs);
      const text = truncate(result.text, MAX_RESULT_CHARS);

      record.status = result.isError ? 'error' : 'ok';
      record.durationMs = Date.now() - started;
      if (result.isError) record.error = text;
      else record.result = text;
      this.emit({ type: 'tool-update', call: { ...record } });

      return {
        type: 'function_result',
        name: call.name,
        call_id: call.id,
        result: [{ type: 'text', text }],
      };
    } catch (err) {
      const message = (err as Error).message || String(err);
      record.status = 'error';
      record.error = message;
      record.durationMs = Date.now() - started;
      this.emit({ type: 'tool-update', call: { ...record } });
      return this.errorResult(call, message);
    }
  }

  /** Executes one git tool, gated by its own approval setting. */
  private async runGitCall(
    call: { id: string; name: string },
    args: Record<string, unknown>,
    settings: AppSettings,
    started: number,
  ): Promise<FunctionResultStep> {
    const record: ToolCallRecord = {
      id: call.id || randomUUID(),
      toolsetName: null,
      toolName: call.name,
      label: call.name,
      args,
      risk: classifyRisk(call.name),
      status: 'pending',
      result: null,
      error: null,
      durationMs: null,
    };

    this.emit({ type: 'tool-call', call: record });

    if (settings.requireGitApproval && record.risk === 'write' && !this.approveAllGit) {
      record.status = 'awaiting-approval';
      this.emit({ type: 'approval-request', call: { ...record } });

      const decision = await new Promise<{ approved: boolean; always: boolean }>((resolve) => {
        this.pending.set(record.id, { resolve });
      });

      if (!decision.approved) {
        record.status = 'denied';
        record.error = 'Declined by the user.';
        record.durationMs = Date.now() - started;
        this.emit({ type: 'tool-update', call: { ...record } });
        return {
          type: 'function_result',
          name: call.name,
          call_id: call.id,
          result: [
            {
              type: 'text',
              text:
                'The user declined this git operation. Do not retry it. Ask what they would ' +
                'prefer before touching the repository again.',
            },
          ],
        };
      }
      if (decision.always) this.approveAllGit = true;
    }

    record.status = 'running';
    this.emit({ type: 'tool-update', call: { ...record } });

    const result = await runGitTool(call.name, args, this.folderPath);
    record.status = result.ok ? 'ok' : 'error';
    record.durationMs = Date.now() - started;
    if (result.ok) record.result = result.output;
    else record.error = result.output;
    this.emit({ type: 'tool-update', call: { ...record } });

    return {
      type: 'function_result',
      name: call.name,
      call_id: call.id,
      result: [{ type: 'text', text: result.output }],
    };
  }

  private errorResult(
    call: { id: string; name: string },
    message: string,
  ): FunctionResultStep {
    return {
      type: 'function_result',
      name: call.name,
      call_id: call.id,
      result: [{ type: 'text', text: 'ERROR: ' + message }],
    };
  }

  private accumulateUsage(interaction: Interaction): void {
    const u = interaction.usage;
    if (!u) return;
    this.usage = {
      requests: this.usage.requests,
      inputTokens: this.usage.inputTokens + (u.total_input_tokens ?? 0),
      outputTokens: this.usage.outputTokens + (u.total_output_tokens ?? 0),
      thoughtTokens: this.usage.thoughtTokens + (u.total_thought_tokens ?? 0),
      totalTokens: this.usage.totalTokens + (u.total_tokens ?? 0),
    };
    this.emit({ type: 'usage', usage: { ...this.usage } });
  }
}

function safeParse(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stripToolsetPrefix(toolName: string, toolsetName: string | null): string {
  if (toolsetName && toolName.startsWith(toolsetName + '.')) {
    return toolName.slice(toolsetName.length + 1);
  }
  // Fall back to the last dotted segment for a fully-qualified name with no toolset given.
  if (!toolsetName && toolName.includes('.')) {
    return toolName.slice(toolName.lastIndexOf('.') + 1);
  }
  return toolName;
}

/** "editor_toolset.toolsets.scene.SceneTools" -> "SceneTools" */
function shortToolsetName(name: string): string {
  const parts = name.split('.');
  return parts[parts.length - 1] || name;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return (
    text.slice(0, max) +
    '\n\n…[truncated ' +
    (text.length - max) +
    ' characters. Narrow the query if you need the rest.]'
  );
}
