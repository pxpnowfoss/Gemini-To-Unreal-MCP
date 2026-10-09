/**
 * Exercises the git tools against a throwaway repository in the temp directory.
 *
 * Nothing here touches a real project and nothing is pushed: the "remote" is a
 * bare repo on disk, so the push path is tested end to end without reaching the
 * network or needing credentials.
 *
 *   npm run check:git
 */

const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { execFileSync } = require('node:child_process');
const { runGitTool, gitRisk } = require('../dist/main/gitTools.js');

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? '  ✓ ' : '  ✕ ') + label + (ok ? '' : ' — ' + detail));
  if (!ok) failures++;
}

const root = mkdtempSync(join(tmpdir(), 'g2u-git-'));
const work = join(root, 'work');
const bare = join(root, 'remote.git');

(async () => {
  try {
    mkdirSync(work, { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' });

    console.log('Guard rails');
    const noFolder = await runGitTool('git_status', {}, null);
    check('no linked folder is explained, not crashed', /no folder is linked/i.test(noFolder.output), noFolder.output.slice(0, 80));
    const missing = await runGitTool('git_status', {}, join(root, 'does-not-exist'));
    check('a missing folder is reported', /no longer exists/i.test(missing.output), missing.output.slice(0, 80));
    const notRepo = await runGitTool('git_status', {}, work);
    check('a non-repository tells you to init', /not a git repository/i.test(notRepo.output), notRepo.output.slice(0, 80));

    console.log('\nSetting up a repository');
    const init = await runGitTool('git_init', { branch: 'main' }, work);
    check('git_init creates the repo', init.ok, init.output.slice(0, 120));
    // Identity so commits work on a machine without a global git config.
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: work, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: work, stdio: 'ignore' });

    const again = await runGitTool('git_init', {}, work);
    check('git_init on an existing repo is a no-op', again.ok && /already/i.test(again.output), again.output.slice(0, 80));

    const badRemote = await runGitTool('git_set_remote', { url: 'not-a-url' }, work);
    check('a bogus remote URL is rejected', !badRemote.ok, badRemote.output.slice(0, 80));
    for (const good of ['https://github.com/me/x.git', 'git@github.com:me/x.git', 'ssh://git@h/x.git']) {
      const r = await runGitTool('git_set_remote', { url: good, name: 'probe' }, work);
      check('accepts ' + good, r.ok, r.output.slice(0, 80));
    }

    const remote = await runGitTool('git_set_remote', { url: 'https://example.com/x.git' }, work);
    check('git_set_remote adds origin', remote.ok, remote.output.slice(0, 120));
    const reset = await runGitTool('git_set_remote', { url: bare.replace(/\\/g, '/') }, work);
    check('git_set_remote updates an existing remote', reset.ok, reset.output.slice(0, 120));

    console.log('\nCommitting');
    const empty = await runGitTool('git_commit', { message: 'nothing' }, work);
    check('refuses to commit a clean tree', !empty.ok && /nothing staged/i.test(empty.output), empty.output.slice(0, 80));

    writeFileSync(join(work, 'a.txt'), 'hello\n');
    writeFileSync(join(work, 'b.txt'), 'world\n');

    const noMessage = await runGitTool('git_commit', {}, work);
    check('refuses to commit without a message', !noMessage.ok && /message/i.test(noMessage.output), noMessage.output.slice(0, 80));

    const status = await runGitTool('git_status', {}, work);
    check('git_status lists untracked files', /a\.txt/.test(status.output), status.output.slice(0, 120));
    check('git_status reports the branch', /branch:/.test(status.output), status.output.slice(0, 80));

    const partial = await runGitTool('git_commit', { message: 'add a only', paths: ['a.txt'] }, work);
    check('commits only the named paths', partial.ok && /a\.txt/.test(partial.output) && !/b\.txt/.test(partial.output),
      partial.output.slice(0, 160));

    const all = await runGitTool('git_commit', { message: 'add the rest' }, work);
    check('commits everything when no paths given', all.ok && /b\.txt/.test(all.output), all.output.slice(0, 160));

    const log = await runGitTool('git_log', { count: 5 }, work);
    check('git_log shows both commits', /add a only/.test(log.output) && /add the rest/.test(log.output), log.output.slice(0, 160));

    console.log('\nDiff');
    writeFileSync(join(work, 'a.txt'), 'hello again\n');
    const summary = await runGitTool('git_diff', {}, work);
    check('diff summary names the file', /a\.txt/.test(summary.output), summary.output.slice(0, 120));
    const patch = await runGitTool('git_diff', { name_only: false }, work);
    check('full patch includes the change', /hello again/.test(patch.output), patch.output.slice(0, 160));

    console.log('\nPushing');
    const noSuchRemote = await runGitTool('git_push', { remote: 'nope' }, work);
    check('unknown remote is reported', !noSuchRemote.ok && /no remote named/i.test(noSuchRemote.output),
      noSuchRemote.output.slice(0, 100));

    await runGitTool('git_commit', { message: 'update a' }, work);
    const push = await runGitTool('git_push', {}, work);
    check('push to the bare remote succeeds', push.ok, push.output.slice(0, 200));

    let remoteLog = '';
    try {
      remoteLog = execFileSync('git', ['log', '--oneline'], { cwd: bare, encoding: 'utf8' });
    } catch (err) {
      remoteLog = '(remote has no commits: ' + String(err.message).split(/\r?\n/)[0] + ')';
    }
    check('commits actually landed on the remote', /update a/.test(remoteLog), remoteLog.slice(0, 160));

    console.log('\nRisk classification');
    check('reads are not gated', gitRisk('git_status') === 'read' && gitRisk('git_diff') === 'read', 'read misclassified');
    check('commit and push are gated', gitRisk('git_commit') === 'write' && gitRisk('git_push') === 'write', 'write misclassified');

    console.log('\nInjection safety');
    const weird = await runGitTool('git_commit', { message: 'x"; git push --force; echo "' }, work);
    check('a shell-looking commit message is inert', !weird.ok || !/force/.test(String(weird.output)),
      String(weird.output).slice(0, 120));
  } catch (err) {
    console.error('Harness error: ' + err.stack);
    failures++;
  } finally {
    rmSync(root, { recursive: true, force: true });
    console.log('\n' + (failures === 0 ? 'Git tools OK.' : failures + ' check(s) FAILED.'));
    process.exitCode = failures === 0 ? 0 : 1;
  }
})();
