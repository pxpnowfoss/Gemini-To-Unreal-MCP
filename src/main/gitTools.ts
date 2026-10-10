/**
 * A small git surface for the model, scoped to the session's linked folder.
 *
 * Everything runs through `execFile` with an argument array and never a shell, so
 * a branch name or commit message cannot turn into a command. Credentials are
 * never handled here: pushes rely on whatever credential helper the user already
 * has configured (Git Credential Manager, the gh CLI, an SSH agent). If that is
 * not set up, the push fails with git's own message rather than this code asking
 * anyone for a password.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Output longer than this is truncated before it goes back to the model. */
const MAX_OUTPUT = 20_000;
const TIMEOUT_MS = 120_000;

export interface GitResult {
  ok: boolean;
  output: string;
}

function run(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const text = [stdout, stderr].filter(Boolean).join('\n').trim();
        const clipped =
          text.length > MAX_OUTPUT
            ? text.slice(0, MAX_OUTPUT) + '\n…[truncated]'
            : text || '(no output)';
        resolve({ ok: !err, output: clipped });
      },
    );
  });
}

/** Resolves and validates the folder a git call should run in. */
function resolveCwd(folderPath: string | null): { ok: true; cwd: string } | { ok: false; error: string } {
  if (!folderPath) {
    return {
      ok: false,
      error:
        'No folder is linked to this session, so there is no repository to work in. ' +
        'Ask the user to link a folder with the folder button in the session bar.',
    };
  }
  if (!existsSync(folderPath)) {
    return { ok: false, error: 'The linked folder no longer exists: ' + folderPath };
  }
  return { ok: true, cwd: folderPath };
}

async function isRepo(cwd: string): Promise<boolean> {
  const res = await run(cwd, ['rev-parse', '--is-inside-work-tree']);
  return res.ok && res.output.trim().startsWith('true');
}

export const GIT_TOOLS = [
  'git_status',
  'git_log',
  'git_diff',
  'git_commit',
  'git_push',
  'git_init',
  'git_set_remote',
  'git_branch',
  'git_switch',
] as const;

export type GitToolName = (typeof GIT_TOOLS)[number];

const READ_ONLY_GIT = new Set(['git_status', 'git_log', 'git_diff', 'git_branch']);

/** Reads are safe to run unattended; the rest change history or publish it. */
export function gitRisk(name: string): 'read' | 'write' {
  return READ_ONLY_GIT.has(name) ? 'read' : 'write';
}

/**
 * Lets git itself decide whether a branch name is legal, rather than guessing at
 * its rules here. Also rejects a leading dash, which would otherwise be read as
 * a flag by whatever command the name is passed to.
 */
async function validBranchName(cwd: string, name: string): Promise<boolean> {
  if (!name || name.startsWith('-')) return false;
  const res = await run(cwd, ['check-ref-format', '--branch', name]);
  return res.ok;
}

export async function runGitTool(
  name: string,
  args: Record<string, unknown>,
  folderPath: string | null,
): Promise<GitResult> {
  const where = resolveCwd(folderPath);
  if (!where.ok) return { ok: false, output: 'ERROR: ' + where.error };
  const cwd = where.cwd;

  // Everything except init needs an existing repository.
  if (name !== 'git_init' && !(await isRepo(cwd))) {
    return {
      ok: false,
      output:
        'ERROR: ' +
        cwd +
        ' is not a git repository. Use git_init to create one, then git_set_remote to ' +
        'point it at GitHub.',
    };
  }

  switch (name) {
    case 'git_status': {
      const branch = await run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const status = await run(cwd, ['status', '--short', '--branch']);
      const remotes = await run(cwd, ['remote', '-v']);
      return {
        ok: status.ok,
        output:
          'branch: ' + branch.output + '\n\nstatus:\n' + status.output + '\n\nremotes:\n' + remotes.output,
      };
    }

    case 'git_log': {
      const count = clampCount(args['count'], 20);
      return run(cwd, ['log', '--oneline', '--decorate', '-n', String(count)]);
    }

    case 'git_diff': {
      const staged = args['staged'] === true;
      const nameOnly = args['name_only'] !== false; // default to the summary
      const flags = ['diff'];
      if (staged) flags.push('--cached');
      flags.push(nameOnly ? '--stat' : '--patch');
      return run(cwd, flags);
    }

    case 'git_commit': {
      const message = typeof args['message'] === 'string' ? args['message'].trim() : '';
      if (!message) return { ok: false, output: 'ERROR: git_commit needs a non-empty `message`.' };

      const paths = Array.isArray(args['paths'])
        ? (args['paths'] as unknown[]).filter((p): p is string => typeof p === 'string')
        : [];

      // `--` stops a path that looks like a flag from being read as one.
      const add = paths.length ? ['add', '--', ...paths] : ['add', '-A'];
      const staged = await run(cwd, add);
      if (!staged.ok) return staged;

      const pending = await run(cwd, ['diff', '--cached', '--name-only']);
      if (!pending.output.trim() || pending.output === '(no output)') {
        return { ok: false, output: 'Nothing staged to commit — the working tree is clean.' };
      }

      const committed = await run(cwd, ['commit', '-m', message]);
      return { ok: committed.ok, output: committed.output + '\n\nfiles:\n' + pending.output };
    }

    case 'git_branch': {
      const current = await run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const local = await run(cwd, ['branch', '-vv']);
      const remote = await run(cwd, ['branch', '-r']);
      return {
        ok: local.ok,
        output:
          'current: ' + current.output.trim() +
          '\n\nlocal branches:\n' + local.output +
          '\n\nremote branches:\n' + remote.output,
      };
    }

    case 'git_switch': {
      const name = typeof args['name'] === 'string' ? args['name'].trim() : '';
      const create = args['create'] === true;
      const from = typeof args['from'] === 'string' ? args['from'].trim() : '';

      if (!(await validBranchName(cwd, name))) {
        return {
          ok: false,
          output:
            'ERROR: "' + name + '" is not a valid branch name. Use something like ' +
            '"feature/stadium-lighting" — no spaces, no leading dash.',
        };
      }

      if (create) {
        if (from && !(await validBranchName(cwd, from))) {
          // `from` can also be a tag or sha, so only reject the obviously unsafe.
          if (from.startsWith('-')) {
            return { ok: false, output: 'ERROR: invalid base ref "' + from + '".' };
          }
        }
        const argv = ['switch', '-c', name];
        if (from) argv.push(from);
        const made = await run(cwd, argv);
        if (!made.ok && /already exists/i.test(made.output)) {
          return {
            ok: false,
            output:
              made.output +
              '\n\nThe branch already exists — call git_switch again without `create` to move to it.',
          };
        }
        return made;
      }

      return run(cwd, ['switch', name]);
    }

    case 'git_push': {
      const explicit = typeof args['branch'] === 'string' ? args['branch'].trim() : '';
      if (explicit && !(await validBranchName(cwd, explicit))) {
        return { ok: false, output: 'ERROR: "' + explicit + '" is not a valid branch name.' };
      }

      const branchRes = await run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const branch = explicit || branchRes.output.trim();
      if (!branch || branch === 'HEAD') {
        return {
          ok: false,
          output:
            'ERROR: not on a branch (detached HEAD). Name a branch with `branch`, or switch to ' +
            'one with git_switch first.',
        };
      }

      const remotes = await run(cwd, ['remote']);
      const remote = typeof args['remote'] === 'string' && args['remote'].trim()
        ? args['remote'].trim()
        : 'origin';
      if (!remotes.output.split(/\s+/).includes(remote)) {
        return {
          ok: false,
          output:
            'ERROR: no remote named "' + remote + '". Use git_set_remote to add one first. ' +
            'Existing remotes: ' + (remotes.output || 'none'),
        };
      }

      // -u covers the first push of a branch that has no upstream yet.
      return run(cwd, ['push', '-u', remote, branch]);
    }

    case 'git_init': {
      if (await isRepo(cwd)) return { ok: true, output: 'Already a git repository.' };
      const branch = typeof args['branch'] === 'string' && args['branch'].trim()
        ? args['branch'].trim()
        : 'main';
      return run(cwd, ['init', '-b', branch]);
    }

    case 'git_set_remote': {
      const url = typeof args['url'] === 'string' ? args['url'].trim() : '';
      const name = typeof args['name'] === 'string' && args['name'].trim()
        ? args['name'].trim()
        : 'origin';
      // Accept every remote form git itself understands — https, ssh, git
      // protocol, scp-style, and a local path or file:// URL. The value is passed
      // as an argv entry and never through a shell, so this is a sanity check
      // against typos rather than a security boundary; being narrow here would
      // only lock out people whose remotes are perfectly valid.
      const looksLikeRemote =
        /^(https?|ssh|git|file):\/\//i.test(url) || // protocol URLs
        /^[\w.-]+@[\w.-]+:.+/.test(url) || // scp-style, e.g. git@github.com:me/x.git
        /^([a-zA-Z]:[\\/]|[\\/])/.test(url); // local absolute path
      if (!looksLikeRemote) {
        return {
          ok: false,
          output:
            'ERROR: "' +
            url +
            '" does not look like a git remote. Use an https:// URL, an ssh:// or ' +
            'git@host:owner/repo.git address, or an absolute path to a local repository.',
        };
      }
      const existing = await run(cwd, ['remote']);
      const verb = existing.output.split(/\s+/).includes(name) ? 'set-url' : 'add';
      return run(cwd, ['remote', verb, name, url]);
    }

    default:
      return { ok: false, output: 'ERROR: unknown git tool "' + name + '".' };
  }
}

function clampCount(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 200);
}
