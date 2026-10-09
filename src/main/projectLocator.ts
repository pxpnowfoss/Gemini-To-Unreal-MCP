/**
 * Works out which Unreal project a folder contains, and which project a running
 * editor actually has open.
 *
 * The MCP server lives inside the editor, so "stay connected to the linked
 * project" really means two things: be able to start that project, and be able to
 * tell whether the editor currently answering on the port is the right one.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, basename, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';

export interface ProjectInfo {
  /** Absolute path to the .uproject file. */
  uprojectPath: string;
  /** Project name, i.e. the file name without its extension. */
  name: string;
  /** Engine version string from EngineAssociation, when readable. */
  engineAssociation: string | null;
}

/**
 * Finds the .uproject for a folder. Checks the folder itself first, then one
 * level down, which covers the common case of linking a repo root that contains
 * the project in a subfolder.
 */
export function findProject(folderPath: string | null): ProjectInfo | null {
  if (!folderPath) return null;
  try {
    if (!statSync(folderPath).isDirectory()) return null;
  } catch {
    return null;
  }

  const direct = firstUproject(folderPath);
  if (direct) return describe(direct);

  // One level down covers linking a repo root whose project sits in a subfolder.
  // If several subfolders are projects the choice is genuinely ambiguous — a
  // folder of projects like C:\Dev is not "a project", and silently picking the
  // alphabetically first one would point the whole session at the wrong place.
  const nested: string[] = [];
  try {
    for (const entry of readdirSync(folderPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const hit = firstUproject(join(folderPath, entry.name));
      if (hit) nested.push(hit);
      if (nested.length > 1) return null;
    }
  } catch {
    /* unreadable folder — treat as no project */
  }
  return nested.length === 1 ? describe(nested[0]) : null;
}

function firstUproject(dir: string): string | null {
  try {
    const hit = readdirSync(dir).find((f) => f.toLowerCase().endsWith('.uproject'));
    return hit ? join(dir, hit) : null;
  } catch {
    return null;
  }
}

function describe(uprojectPath: string): ProjectInfo {
  let engineAssociation: string | null = null;
  try {
    const parsed = JSON.parse(readFileSync(uprojectPath, 'utf8')) as {
      EngineAssociation?: string;
    };
    engineAssociation = parsed.EngineAssociation ?? null;
  } catch {
    /* a malformed .uproject still tells us the project exists */
  }
  return {
    uprojectPath,
    name: basename(uprojectPath).replace(/\.uproject$/i, ''),
    engineAssociation,
  };
}

/**
 * Returns the .uproject path of every running Unreal editor, read from each
 * process's command line. Best effort: if the query fails we simply do not warn.
 */
export function runningEditorProjects(): Promise<string[]> {
  return new Promise((done) => {
    if (process.platform !== 'win32') return done([]);

    const script =
      "Get-CimInstance Win32_Process -Filter \"Name='UnrealEditor.exe'\" " +
      '| Select-Object -ExpandProperty CommandLine';

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return done([]);
        const out: string[] = [];
        for (const line of stdout.split('\n')) {
          // The project is the first .uproject-looking token on the command line,
          // quoted or not.
          const match = /"([^"]+\.uproject)"|(\S+\.uproject)/i.exec(line);
          const hit = match?.[1] ?? match?.[2];
          if (hit) out.push(hit.trim());
        }
        done(out);
      },
    );
  });
}

/** True when two paths point at the same file, ignoring case and separators. */
export function samePath(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => resolve(p).replace(/[\\/]+/g, sep).toLowerCase();
  return norm(a) === norm(b);
}

export function projectExists(info: ProjectInfo | null): boolean {
  return Boolean(info && existsSync(info.uprojectPath));
}
