/**
 * Minimal MCP client for the "Streamable HTTP" transport, written against the
 * 2025-06-18 revision of the spec.
 *
 * The Unreal Editor MCP server answers POSTs with either `application/json` or
 * `text/event-stream` depending on the request, and hands out a session id in the
 * `Mcp-Session-Id` response header that must be echoed on every later call. If the
 * editor restarts, that session disappears and the server replies 404 — we detect
 * that and transparently re-initialize once.
 */

const PROTOCOL_VERSION = '2025-06-18';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

export interface McpToolResult {
  /** Flattened text of the result, ready to hand back to the model. */
  text: string;
  isError: boolean;
  raw: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

export class McpError extends Error {
  readonly sessionExpired: boolean;

  constructor(message: string, sessionExpired = false) {
    super(message);
    this.name = 'McpError';
    this.sessionExpired = sessionExpired;
  }
}

export class McpClient {
  private sessionId: string | null = null;
  private nextId = 1;
  private initializing: Promise<void> | null = null;
  private negotiatedVersion = PROTOCOL_VERSION;

  constructor(private url: string) {}

  get endpoint(): string {
    return this.url;
  }

  get isConnected(): boolean {
    return this.sessionId !== null;
  }

  setUrl(url: string): void {
    if (url !== this.url) {
      this.sessionId = null;
      this.url = url;
    }
  }

  /** Opens a session. Safe to call repeatedly; concurrent callers share one handshake. */
  async connect(): Promise<void> {
    if (this.sessionId) return;
    if (this.initializing) return this.initializing;

    this.initializing = (async () => {
      const res = await this.post(
        {
          jsonrpc: '2.0',
          id: this.nextId++,
          method: 'initialize',
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'gemini-to-unreal-mcp', version: '1.0.0' },
          },
        },
        { skipSession: true },
      );

      const sid = res.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;

      const body = await this.readRpc(res, 'initialize');
      if (body.error) throw new McpError('initialize failed: ' + body.error.message);
      if (typeof body.result?.protocolVersion === 'string') {
        this.negotiatedVersion = body.result.protocolVersion;
      }

      // The spec requires this notification before any other request.
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {
        /* notifications are fire-and-forget; a non-2xx here is not fatal */
      });
    })();

    try {
      await this.initializing;
    } catch (err) {
      this.sessionId = null;
      throw err;
    } finally {
      this.initializing = null;
    }
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.request('tools/list', {});
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    return tools as McpTool[];
  }

  async callTool(name: string, args: unknown): Promise<McpToolResult> {
    const result = await this.request('tools/call', { name, arguments: args ?? {} });

    const blocks = Array.isArray(result?.content) ? result.content : [];
    const parts: string[] = [];
    for (const block of blocks) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      } else if (block?.type === 'resource' && block.resource) {
        parts.push(JSON.stringify(block.resource));
      } else if (block?.type === 'image') {
        parts.push('[image omitted]');
      }
    }
    // Servers may also answer with a typed `structuredContent` payload.
    if (!parts.length && result?.structuredContent !== undefined) {
      parts.push(JSON.stringify(result.structuredContent));
    }
    if (!parts.length) parts.push('(no output)');

    return { text: parts.join('\n'), isError: result?.isError === true, raw: result };
  }

  async close(): Promise<void> {
    const sid = this.sessionId;
    this.sessionId = null;
    if (!sid) return;
    try {
      await fetch(this.url, {
        method: 'DELETE',
        headers: { 'Mcp-Session-Id': sid, 'MCP-Protocol-Version': this.negotiatedVersion },
      });
    } catch {
      /* the editor may already be gone; nothing to clean up */
    }
  }

  /** Issues a request, re-initializing once if the server says our session is gone. */
  private async request(method: string, params: unknown, retrying = false): Promise<any> {
    await this.connect();
    const id = this.nextId++;

    let res: Response;
    try {
      res = await this.post({ jsonrpc: '2.0', id, method, params });
    } catch (err) {
      if (err instanceof McpError && err.sessionExpired && !retrying) {
        this.sessionId = null;
        return this.request(method, params, true);
      }
      throw err;
    }

    const body = await this.readRpc(res, method);
    if (body.error) throw new McpError(method + ' failed: ' + body.error.message);
    return body.result;
  }

  private async post(payload: unknown, opts: { skipSession?: boolean } = {}): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (!opts.skipSession && this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (!opts.skipSession) headers['MCP-Protocol-Version'] = this.negotiatedVersion;

    let res: Response;
    try {
      res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(payload) });
    } catch (err) {
      throw new McpError(
        'Cannot reach the Unreal MCP server at ' +
          this.url +
          '. Is the editor running with the MCP plugin enabled? (' +
          (err as Error).message +
          ')',
      );
    }

    if (res.status === 404 && this.sessionId) {
      throw new McpError('MCP session expired', true);
    }
    if (res.status === 202) return res; // accepted notification, no body
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new McpError(
        ('MCP server returned ' + res.status + ' ' + res.statusText + '. ' + detail).trim(),
      );
    }
    return res;
  }

  /**
   * Reads a JSON-RPC response from either a plain JSON body or an SSE stream.
   * For SSE we scan `data:` frames and keep the first one that is a response
   * rather than a server-initiated request or notification.
   */
  private async readRpc(res: Response, method: string): Promise<JsonRpcResponse> {
    if (res.status === 202) return { jsonrpc: '2.0' };

    const contentType = res.headers.get('content-type') ?? '';
    const raw = await res.text();
    if (!raw.trim()) return { jsonrpc: '2.0' };

    if (!contentType.includes('text/event-stream')) {
      try {
        return JSON.parse(raw) as JsonRpcResponse;
      } catch {
        throw new McpError(method + ': server sent a non-JSON body: ' + raw.slice(0, 300));
      }
    }

    for (const frame of raw.split(/\n\n/)) {
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('');
      if (!data) continue;
      try {
        const parsed = JSON.parse(data) as JsonRpcResponse;
        if (parsed.result !== undefined || parsed.error !== undefined) return parsed;
      } catch {
        /* skip keep-alives and partial frames */
      }
    }
    throw new McpError(method + ': no JSON-RPC response found in the event stream');
  }
}
