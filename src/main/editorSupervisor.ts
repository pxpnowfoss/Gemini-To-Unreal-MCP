/**
 * Keeps the MCP connection in step with whatever the editor is doing.
 *
 * The server only exists while Unreal is open, so the connection is not something
 * you establish once — it comes and goes as the user opens and closes the editor.
 * This watches both directions: it retries quietly while disconnected and picks the
 * editor up the moment it appears, and it heartbeats while connected so closing the
 * editor is noticed rather than discovered on the user's next message.
 */

const RETRY_MIN_MS = 2_000;
/*
 * Deliberately short. A failed connect to a closed local port costs almost
 * nothing, and this is the delay the user feels between Unreal finishing its
 * startup and the app noticing — a 15s ceiling made "always connected" feel
 * broken for no saving worth having.
 */
const RETRY_MAX_MS = 5_000;
const HEARTBEAT_MS = 20_000;

export interface SupervisorHooks {
  /** Attempt a connection; resolves true when connected. */
  tryConnect: () => Promise<boolean>;
  /** Cheap liveness probe against an open session; false means it is gone. */
  probe: () => Promise<boolean>;
  /** True while a turn is running — the agent's own traffic is proof of life. */
  isBusy: () => boolean;
  /** Called when the connection drops, so the UI can update. */
  onLost: () => void;
}

export class EditorSupervisor {
  private timer: NodeJS.Timeout | null = null;
  private backoff = RETRY_MIN_MS;
  private connected = false;
  private stopped = true;
  private inFlight = false;

  constructor(private hooks: SupervisorHooks) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // Try at once: at launch the editor is often already running, and waiting out
    // a retry interval before the first attempt just looks like a slow app.
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Tells the supervisor the connection state changed outside of its own loop. */
  setConnected(connected: boolean): void {
    this.connected = connected;
    this.backoff = RETRY_MIN_MS;
    if (!this.stopped) this.schedule(connected ? HEARTBEAT_MS : RETRY_MIN_MS);
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.inFlight) return;
    this.inFlight = true;

    try {
      if (this.connected) {
        // The agent's own calls already prove the editor is there.
        if (this.hooks.isBusy()) {
          this.schedule(HEARTBEAT_MS);
          return;
        }
        const alive = await this.hooks.probe();
        if (alive) {
          this.schedule(HEARTBEAT_MS);
        } else {
          this.connected = false;
          this.backoff = RETRY_MIN_MS;
          this.hooks.onLost();
          this.schedule(RETRY_MIN_MS);
        }
        return;
      }

      const ok = await this.hooks.tryConnect();
      if (ok) {
        this.connected = true;
        this.backoff = RETRY_MIN_MS;
        this.schedule(HEARTBEAT_MS);
      } else {
        // Back off so a closed editor is not hammered every two seconds all day.
        this.backoff = Math.min(this.backoff * 1.5, RETRY_MAX_MS);
        this.schedule(this.backoff);
      }
    } finally {
      this.inFlight = false;
    }
  }
}
