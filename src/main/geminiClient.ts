/**
 * Client for the Gemini Interactions API.
 *
 *   POST https://generativelanguage.googleapis.com/v1beta/interactions
 *
 * The app runs the tool loop in "stateful" mode: every request after the first
 * passes `previous_interaction_id` instead of replaying the transcript. That keeps
 * the payload small and, more importantly, leaves the model's thought signatures
 * on Google's side — replaying them by hand is the usual source of broken tool
 * loops with thinking models.
 */

import type { ModelInfo, ThinkingLevel } from '../shared/types';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Ceiling for one interaction request. High reasoning over a big tool result is slow. */
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

/** Overload (503) and rate limits (429) are common; ride them out rather than failing. */
const MAX_RETRIES = 5;

/**
 * Longest backoff worth waiting through. Beyond this, a Retry-After is telling us
 * a quota has run out, not that the server is briefly busy.
 */
const RETRY_WAIT_CAP_MS = 90 * 1000;

/** "25789s" means nothing to a reader; "7h 10m" does. */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? h + 'h ' + rem + 'm' : h + 'h';
}

export interface RetryInfo {
  attempt: number;
  max: number;
  waitMs: number;
  reason: string;
}

/** A sleep that the user's Stop button can interrupt. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('Cancelled', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface FunctionDeclaration {
  type: 'function';
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface FunctionCallStep {
  type: 'function_call';
  id: string;
  name: string;
  /** The API may hand this back as a JSON string or as an already-parsed object. */
  arguments: unknown;
}

export interface FunctionResultStep {
  type: 'function_result';
  name: string;
  call_id: string;
  result: Array<{ type: 'text'; text: string }>;
}

export interface InteractionStep {
  type: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  content?: Array<{ type: string; text?: string }>;
  text?: string;
  [key: string]: unknown;
}

export interface Interaction {
  id: string;
  status:
    | 'in_progress'
    | 'requires_action'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'incomplete'
    | 'queued';
  steps?: InteractionStep[];
  usage?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    total_thought_tokens?: number;
    total_tokens?: number;
  };
  errors?: unknown;
}

export interface CreateInteractionOptions {
  model: string;
  input: string | InteractionStep[] | FunctionResultStep[];
  tools?: FunctionDeclaration[];
  systemInstruction?: string;
  previousInteractionId?: string | null;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
}

export class GeminiError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status = 0, retryable = false) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
    this.retryable = retryable;
  }
}

export class GeminiClient {
  constructor(private apiKey: string) {}

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  /** Called when a request is about to be retried, so the UI can explain the pause. */
  onRetry: ((info: RetryInfo) => void) | null = null;

  private headers(): Record<string, string> {
    // The key goes in a header, never the query string, so it stays out of logs.
    return { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey };
  }

  /** Verifies the key by listing models. Returns the models that can be used here. */
  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await fetch(BASE + '/models?pageSize=1000', {
      headers: { 'x-goog-api-key': this.apiKey },
      signal,
    }).catch((err) => {
      throw new GeminiError('Could not reach the Gemini API: ' + (err as Error).message);
    });

    if (!res.ok) throw await this.toError(res);

    const body = (await res.json()) as {
      models?: Array<{
        name?: string;
        displayName?: string;
        description?: string;
        inputTokenLimit?: number;
        outputTokenLimit?: number;
        supportedGenerationMethods?: string[];
      }>;
    };

    const out: ModelInfo[] = [];
    for (const m of body.models ?? []) {
      const id = (m.name ?? '').replace(/^models\//, '');
      if (!id.startsWith('gemini-')) continue;
      // Skip model families that cannot drive a text/tool conversation.
      if (/embedding|aqa|imagen|veo|tts|-image|native-audio|-live/.test(id)) continue;
      out.push({
        id,
        displayName: m.displayName || id,
        description: m.description || '',
        inputTokenLimit: m.inputTokenLimit ?? 0,
        outputTokenLimit: m.outputTokenLimit ?? 0,
      });
    }

    out.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
    return out;
  }

  async createInteraction(opts: CreateInteractionOptions): Promise<Interaction> {
    const body: Record<string, unknown> = {
      model: opts.model,
      input: opts.input,
      store: true,
    };

    if (opts.tools?.length) body.tools = opts.tools;
    if (opts.systemInstruction) body.system_instruction = opts.systemInstruction;
    if (opts.previousInteractionId) body.previous_interaction_id = opts.previousInteractionId;

    body.generation_config = {
      tool_choice: 'auto',
      thinking_summaries: true,
      ...(opts.thinkingLevel ? { thinking_level: opts.thinkingLevel } : {}),
    };

    try {
      return await this.postInteraction(body, opts.signal);
    } catch (err) {
      // `generation_config` is the part of this request most likely to drift as the
      // API evolves. If the server rejects a field in it, drop the tuning knobs and
      // retry once rather than failing the user's message outright.
      if (
        err instanceof GeminiError &&
        err.status === 400 &&
        /generation_config|thinking_level|thinking_summaries|tool_choice/i.test(err.message)
      ) {
        this.generationConfigRejected = err.message;
        delete body.generation_config;
        return this.postInteraction(body, opts.signal);
      }
      throw err;
    }
  }

  /** Set when the server rejected our generation_config, for surfacing in logs. */
  generationConfigRejected: string | null = null;

  private async postInteraction(
    body: Record<string, unknown>,
    signal?: AbortSignal,
    attempt = 0,
  ): Promise<Interaction> {
    // A high thinking level over a large tool result can legitimately take a
    // minute or two, but without a ceiling a stalled request hangs the app with
    // no way out but quitting it.
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await fetch(BASE + '/interactions', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (err) {
      // Distinguish "the user pressed Stop" from "the API went quiet".
      if (timeout.aborted && !signal?.aborted) {
        throw new GeminiError(
          'Gemini did not respond within ' +
            Math.round(REQUEST_TIMEOUT_MS / 1000) +
            ' seconds. Lowering "Reasoning effort" in Settings makes each step much faster.',
          0,
          true,
        );
      }
      if ((err as Error).name === 'AbortError' || (err as Error).name === 'TimeoutError') throw err;
      throw new GeminiError('Could not reach the Gemini API: ' + (err as Error).message);
    }

    if (!res.ok) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const error = await this.toError(res);

      // Rate limits and 5xx overload are the normal weather of a busy model, not
      // a reason to drop the user's turn. Honour Retry-After when the server sends
      // one, otherwise back off exponentially with jitter so a burst of clients
      // does not retry in lockstep.
      if (error.retryable && attempt < MAX_RETRIES) {
        const serverWaitMs =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;

        // A Retry-After measured in hours is not a busy server, it is an exhausted
        // quota. Waiting it out would park the app until tomorrow, so say so and
        // stop instead.
        if (serverWaitMs > RETRY_WAIT_CAP_MS) {
          throw new GeminiError(
            'Gemini will not accept more requests on this key for about ' +
              formatDuration(serverWaitMs) +
              '. That is a quota limit, not a busy server. If other models fail the ' +
              'same way, the limit is on the key’s project rather than one model — ' +
              'either enable billing on that project, use a key from another project, ' +
              'or wait for the daily reset. Google’s own detail: ' +
              (error.message || 'none given'),
            res.status,
            false,
          );
        }

        const base = serverWaitMs || Math.min(2000 * Math.pow(2, attempt), 30_000);
        const waitMs = Math.round(base + Math.random() * 1000);

        this.onRetry?.({
          attempt: attempt + 1,
          max: MAX_RETRIES,
          waitMs,
          reason: res.status === 429 ? 'rate limited' : 'model busy',
        });

        await sleep(waitMs, signal);
        return this.postInteraction(body, signal, attempt + 1);
      }
      throw error;
    }

    return (await res.json()) as Interaction;
  }

  private async toError(res: Response): Promise<GeminiError> {
    type ApiError = { error?: { message?: string; status?: string; details?: unknown[] } };

    let detail = '';
    let reason = '';
    try {
      const parsed = (await res.json()) as ApiError | ApiError[];
      // The interactions endpoint wraps its error in a single-element array,
      // while /models returns the bare object. Accept either.
      const err = (Array.isArray(parsed) ? parsed[0]?.error : parsed.error) ?? {};
      detail = err.message ?? '';
      reason = err.status ?? '';
      for (const d of err.details ?? []) {
        const r = (d as { reason?: string })?.reason;
        if (r) reason = r;
      }
    } catch {
      detail = await res.text().catch(() => '');
    }

    const retryable = res.status === 429 || res.status >= 500;

    // An invalid key comes back as a 400, not a 401, so key problems are
    // identified by reason rather than status.
    const badKey =
      /API_KEY_INVALID|API_KEY_SERVICE_BLOCKED|PERMISSION_DENIED/.test(reason) ||
      /api key not valid|api key expired/i.test(detail);
    if (badKey) {
      return new GeminiError(
        'Gemini refused this API key: ' +
          (detail || 'the key is not valid') +
          ' Create a key at https://aistudio.google.com/apikey and make sure the Generative Language API is enabled for its project.',
        res.status,
        false,
      );
    }

    let message: string;
    switch (res.status) {
      case 400:
        message = 'Gemini rejected the request: ' + (detail || 'bad request');
        break;
      case 401:
      case 403:
        message =
          'Gemini refused the API key (HTTP ' +
          res.status +
          '). Check that the key is valid and that the Generative Language API is enabled for it. ' +
          detail;
        break;
      case 404:
        message =
          'Model or endpoint not found (HTTP 404). The selected model may have been retired — pick another in Settings. ' +
          detail;
        break;
      case 429:
        message = 'Gemini rate limit or quota reached. ' + detail;
        break;
      case 503:
        message =
          'Gemini is overloaded right now (503) and did not recover after ' +
          MAX_RETRIES +
          ' retries. This is on the Google side and usually clears within a few minutes. ' +
          'Send the message again, or switch to a different model in Settings. ' +
          detail;
        break;
      default:
        message = 'Gemini API error ' + res.status + ' ' + res.statusText + '. ' + detail;
    }
    return new GeminiError(message.trim(), res.status, retryable);
  }
}

/** Pulls the function calls out of an interaction that is waiting on tools. */
export function extractFunctionCalls(interaction: Interaction): FunctionCallStep[] {
  const calls: FunctionCallStep[] = [];
  for (const step of interaction.steps ?? []) {
    if (step.type === 'function_call' && typeof step.name === 'string') {
      calls.push({
        type: 'function_call',
        id: String(step.id ?? ''),
        name: step.name,
        arguments: step.arguments,
      });
    }
  }
  return calls;
}

/** Concatenates the assistant's visible text from an interaction's steps. */
export function extractText(interaction: Interaction): string {
  const parts: string[] = [];
  for (const step of interaction.steps ?? []) {
    if (step.type !== 'model_output') continue;
    for (const block of step.content ?? []) {
      if (block.type === 'text' && block.text) parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

/** Thought summaries, when the model emitted any. */
export function extractThoughts(interaction: Interaction): string[] {
  const out: string[] = [];
  for (const step of interaction.steps ?? []) {
    if (step.type === 'thought' || step.type === 'thought_summary') {
      const direct = typeof step.text === 'string' ? step.text : '';
      const nested = (step.content ?? [])
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text as string)
        .join('\n');
      const text = (direct || nested).trim();
      if (text) out.push(text);
    }
  }
  return out;
}
