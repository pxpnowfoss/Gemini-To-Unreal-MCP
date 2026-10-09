/**
 * Persistent sessions.
 *
 * Each session is one JSON file under `<userData>/sessions/`, holding its own
 * transcript, linked folder, token usage and — importantly — the id of the last
 * Gemini interaction, so reopening a session resumes the same server-side thread
 * rather than starting a fresh one.
 *
 * Writes are debounced: a busy turn appends many entries a second, and rewriting
 * the file each time would be wasteful. Anything in flight is flushed on switch
 * and on quit, so the worst case is losing the tail of a turn to a hard crash.
 */

import { app } from 'electron';
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SessionRecord, SessionSummary, TranscriptEntry, UsageTotals } from '../shared/types';

const EMPTY_USAGE: UsageTotals = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  thoughtTokens: 0,
  totalTokens: 0,
};

/** Keeps a session file from growing without bound in a very long conversation. */
const MAX_ENTRIES = 2000;

export class SessionStore {
  private dir: string;
  private pointerFile: string;
  private active: SessionRecord | null = null;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.dir = join(app.getPath('userData'), 'sessions');
    this.pointerFile = join(app.getPath('userData'), 'active-session.json');
    mkdirSync(this.dir, { recursive: true });
  }

  // ------------------------------------------------------------------ listing

  list(): SessionSummary[] {
    const out: SessionSummary[] = [];
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.json')) continue;
      const record = this.readFile(join(this.dir, file));
      if (record) out.push(toSummary(record));
    }
    // Most recently used first — that is the order people look for.
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return out;
  }

  // ------------------------------------------------------------- active session

  /** Loads the last-used session, falling back to the newest, else creates one. */
  openInitial(): SessionRecord {
    const remembered = this.readPointer();
    if (remembered) {
      const record = this.load(remembered);
      if (record) return record;
    }
    const [newest] = this.list();
    if (newest) {
      const record = this.load(newest.id);
      if (record) return record;
    }
    return this.create();
  }

  get current(): SessionRecord | null {
    return this.active;
  }

  create(title?: string, folderPath: string | null = null): SessionRecord {
    this.flush();
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id: randomUUID(),
      title: title?.trim() || 'New session',
      folderPath,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      previousInteractionId: null,
      usage: { ...EMPTY_USAGE },
      entries: [],
    };
    this.active = record;
    this.writeNow(record);
    this.writePointer(record.id);
    return record;
  }

  load(id: string): SessionRecord | null {
    const record = this.readFile(this.pathFor(id));
    if (!record) return null;
    this.flush();
    this.active = record;
    this.writePointer(id);
    return record;
  }

  delete(id: string): void {
    const file = this.pathFor(id);
    if (existsSync(file)) rmSync(file);
    if (this.active?.id === id) {
      this.active = null;
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
    }
  }

  // ------------------------------------------------------------------ mutation

  rename(id: string, title: string): SessionRecord | null {
    const record = this.active?.id === id ? this.active : this.readFile(this.pathFor(id));
    if (!record) return null;
    record.title = title.trim() || record.title;
    record.updatedAt = new Date().toISOString();
    this.writeNow(record);
    return record;
  }

  setFolder(id: string, folderPath: string | null): SessionRecord | null {
    const record = this.active?.id === id ? this.active : this.readFile(this.pathFor(id));
    if (!record) return null;
    record.folderPath = folderPath;
    record.updatedAt = new Date().toISOString();
    this.writeNow(record);
    return record;
  }

  /** Appends to the active session. A no-op when nothing is open. */
  append(entry: TranscriptEntry): void {
    const record = this.active;
    if (!record) return;

    // A tool card is emitted once then updated in place; replace rather than append.
    if (entry.kind === 'tool') {
      const i = record.entries.findIndex(
        (e) => e.kind === 'tool' && e.call.id === entry.call.id,
      );
      if (i >= 0) {
        record.entries[i] = entry;
        this.touch();
        return;
      }
    }

    record.entries.push(entry);
    if (entry.kind === 'user') {
      record.messageCount++;
      // Name an untitled session after its opening line.
      if (record.title === 'New session') {
        record.title = entry.text.replace(/\s+/g, ' ').trim().slice(0, 60) || record.title;
      }
    }
    if (record.entries.length > MAX_ENTRIES) {
      record.entries.splice(0, record.entries.length - MAX_ENTRIES);
    }
    this.touch();
  }

  setInteractionId(id: string | null): void {
    if (!this.active) return;
    this.active.previousInteractionId = id;
    this.touch();
  }

  setUsage(usage: UsageTotals): void {
    if (!this.active) return;
    this.active.usage = usage;
    this.touch();
  }

  // ------------------------------------------------------------------ plumbing

  private pathFor(id: string): string {
    // Ids are generated UUIDs, but never let one escape the sessions directory.
    const safe = id.replace(/[^a-zA-Z0-9-]/g, '');
    return join(this.dir, safe + '.json');
  }

  private readFile(file: string): SessionRecord | null {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as SessionRecord;
      if (!parsed?.id) return null;
      return {
        ...parsed,
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
        usage: { ...EMPTY_USAGE, ...(parsed.usage ?? {}) },
      };
    } catch {
      return null;
    }
  }

  private touch(): void {
    if (!this.active) return;
    this.active.updatedAt = new Date().toISOString();
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.active) this.writeNow(this.active);
    }, 400);
  }

  /** Writes any pending change immediately. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.active) this.writeNow(this.active);
  }

  private writeNow(record: SessionRecord): void {
    try {
      const file = this.pathFor(record.id);
      const tmp = file + '.tmp';
      writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
      renameSync(tmp, file);
    } catch {
      // Losing a transcript write should never take the app down.
    }
  }

  private writePointer(id: string): void {
    try {
      writeFileSync(this.pointerFile, JSON.stringify({ activeId: id }), 'utf8');
    } catch {
      /* the pointer is a convenience; the newest session is a fine fallback */
    }
  }

  private readPointer(): string | null {
    try {
      const parsed = JSON.parse(readFileSync(this.pointerFile, 'utf8')) as { activeId?: string };
      return parsed.activeId ?? null;
    } catch {
      return null;
    }
  }
}

export function toSummary(record: SessionRecord): SessionSummary {
  return {
    id: record.id,
    title: record.title,
    folderPath: record.folderPath,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    messageCount: record.messageCount,
  };
}
