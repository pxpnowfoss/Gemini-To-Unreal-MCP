/**
 * Settings and credential storage.
 *
 * The Gemini API key is encrypted with Electron's `safeStorage`, which on Windows
 * is DPAPI scoped to the logged-in user account — the ciphertext is useless if the
 * file is copied to another machine or user. If the OS refuses to provide a backing
 * store (some Linux desktops without a keyring), we refuse to write the key to disk
 * rather than silently downgrading to plaintext, and say so in the UI.
 */

import { app, safeStorage } from 'electron';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DEFAULT_SETTINGS } from '../shared/types';
import type { AppSettings, CredentialStatus } from '../shared/types';

interface PersistedFile {
  version: 1;
  settings: AppSettings;
  /** Base64 of the safeStorage-encrypted API key. */
  apiKeyEnc?: string;
  /** Last 4 characters of the key, kept so the UI can show which key is saved. */
  apiKeyHint?: string;
}

export class Store {
  private file: string;
  private data: PersistedFile;
  /** Held in memory only, for the case where the OS has no keychain. */
  private volatileKey: string | null = null;

  constructor() {
    this.file = join(app.getPath('userData'), 'config.json');
    this.data = this.load();
  }

  private load(): PersistedFile {
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as PersistedFile;
        return {
          version: 1,
          settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
          apiKeyEnc: parsed.apiKeyEnc,
          apiKeyHint: parsed.apiKeyHint,
        };
      } catch {
        // A corrupt config should not stop the app from starting.
      }
    }
    return { version: 1, settings: { ...DEFAULT_SETTINGS } };
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    // Write to a temp file then rename, so a crash mid-write cannot truncate the config.
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.file);
  }

  get settings(): AppSettings {
    return { ...this.data.settings };
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.data.settings = { ...this.data.settings, ...patch };
    this.persist();
    return this.settings;
  }

  encryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  /** Returns null when no key is stored or it cannot be decrypted. */
  getApiKey(): string | null {
    if (this.volatileKey) return this.volatileKey;
    if (!this.data.apiKeyEnc) return null;
    try {
      return safeStorage.decryptString(Buffer.from(this.data.apiKeyEnc, 'base64'));
    } catch {
      return null;
    }
  }

  /**
   * Saves the key. When the OS cannot encrypt, the key is kept for this run only
   * and `encrypted: false` is reported so the UI can explain why it will not persist.
   */
  setApiKey(key: string): CredentialStatus {
    const trimmed = key.trim();
    if (!trimmed) return this.clearApiKey();

    if (this.encryptionAvailable()) {
      this.volatileKey = null;
      this.data.apiKeyEnc = safeStorage.encryptString(trimmed).toString('base64');
      this.data.apiKeyHint = trimmed.slice(-4);
      this.persist();
    } else {
      this.volatileKey = trimmed;
      delete this.data.apiKeyEnc;
      this.data.apiKeyHint = trimmed.slice(-4);
      this.persist();
    }
    return this.credentialStatus();
  }

  clearApiKey(): CredentialStatus {
    this.volatileKey = null;
    delete this.data.apiKeyEnc;
    delete this.data.apiKeyHint;
    this.persist();
    return this.credentialStatus();
  }

  /**
   * Reports whether a key is actually *usable*, not merely present. Stored
   * ciphertext can outlive the OS key that encrypted it (safeStorage's AES key
   * lives in Chromium's `Local State`), and saying "key saved" in that state
   * sends the user hunting through Gemini errors for what is really "re-enter
   * your key".
   *
   * It reports the problem but never deletes the stored value: a decrypt failure
   * is not always permanent — a second instance sharing this profile can cause a
   * transient one — and throwing away a credential on a transient error is far
   * worse than reporting it. Clearing stays an explicit user action, and saving a
   * new key overwrites it anyway.
   */
  credentialStatus(): CredentialStatus {
    if (this.volatileKey) {
      return { hasKey: true, encrypted: false, hint: this.data.apiKeyHint ?? null, stale: false };
    }

    if (!this.data.apiKeyEnc) {
      return { hasKey: false, encrypted: false, hint: null, stale: false };
    }

    if (this.getApiKey()) {
      return { hasKey: true, encrypted: true, hint: this.data.apiKeyHint ?? null, stale: false };
    }

    return { hasKey: false, encrypted: true, hint: this.data.apiKeyHint ?? null, stale: true };
  }

  get configPath(): string {
    return this.file;
  }
}
