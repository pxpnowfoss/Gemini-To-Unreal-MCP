/**
 * Checks how a linked folder is resolved to an Unreal project, and how the app
 * compares that against whatever editors are running.
 *
 *   npm run check:project
 */

const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { findProject, samePath, projectExists, runningEditorProjects } = require('../dist/main/projectLocator.js');

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? '  ✓ ' : '  ✕ ') + label + (ok ? '' : ' — ' + detail));
  if (!ok) failures++;
}

function uproject(dir, name, engine) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, name + '.uproject'),
    JSON.stringify({ FileVersion: 3, EngineAssociation: engine ?? '5.8' }),
  );
}

const root = mkdtempSync(join(tmpdir(), 'g2u-proj-'));

try {
  console.log('Resolving a linked folder to a project');

  // A folder that is itself a project.
  const direct = join(root, 'DirectProject');
  uproject(direct, 'DirectProject', '5.8');
  const a = findProject(direct);
  check('finds a .uproject in the folder itself', a?.name === 'DirectProject', String(a?.name));
  check('reads EngineAssociation', a?.engineAssociation === '5.8', String(a?.engineAssociation));

  // A repo root with the project one level down.
  const repo = join(root, 'repo');
  uproject(join(repo, 'Game'), 'NestedGame', '5.6');
  const b = findProject(repo);
  check('finds a project one level down', b?.name === 'NestedGame', String(b?.name));

  // A folder of several projects is ambiguous and must not guess.
  const many = join(root, 'many');
  uproject(join(many, 'One'), 'One');
  uproject(join(many, 'Two'), 'Two');
  check('refuses to guess between sibling projects', findProject(many) === null, String(findProject(many)?.name));

  // Nothing to find.
  check('no project in an empty folder', findProject(join(root, 'nope')) === null, 'returned something');
  check('null folder is handled', findProject(null) === null, 'returned something');
  check('a file path is not a project folder', findProject(join(direct, 'DirectProject.uproject')) === null, 'returned something');

  console.log('\nComparing paths the way Windows does');
  const p1 = 'C:' + '\\' + 'Dev' + '\\' + 'Game' + '\\' + 'A.uproject';
  const p2 = 'c:/dev/game/a.uproject';
  check('case and separators are ignored', samePath(p1, p2), p1 + '  vs  ' + p2);
  check('different projects do not match', !samePath(p1, 'C:/Dev/Game/B.uproject'), 'false match');
  check('null never matches', !samePath(null, p2) && !samePath(p1, null), 'null matched');

  console.log('\nExistence');
  check('an existing project reports true', projectExists(a), 'said missing');
  check('a deleted project reports false', !projectExists({ uprojectPath: join(root, 'gone.uproject') }), 'said present');

  console.log('\nRunning editors');
  runningEditorProjects()
    .then(async (list) => {
      check('query returns an array', Array.isArray(list), typeof list);
      console.log('    currently open: ' + (list.length ? list.join(', ') : '(none)'));
      await supervisorChecks();
      finish();
    })
    .catch((err) => {
      check('query does not throw', false, err.message);
      finish();
    });
} catch (err) {
  console.error('Harness error: ' + err.stack);
  failures++;
  finish();
}

/** The supervisor is what makes the connection survive the editor coming and going. */
async function supervisorChecks() {
  const { EditorSupervisor } = require('../dist/main/editorSupervisor.js');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  console.log('\nReconnect supervisor');

  // 1. Picks the editor up once it finally answers.
  let attempts = 0;
  let connected = false;
  const sup = new EditorSupervisor({
    tryConnect: async () => {
      attempts++;
      connected = attempts >= 3; // "editor started" on the third try
      return connected;
    },
    probe: async () => connected,
    isBusy: () => false,
    onLost: () => {},
  });
  sup.start();
  await sleep(9000);
  sup.stop();
  check('keeps retrying while the editor is closed', attempts >= 3, 'attempts=' + attempts);
  check('connects as soon as the editor answers', connected === true, 'never connected');

  // 2. Backs off rather than hammering a closed editor all day.
  let tries = 0;
  const sup2 = new EditorSupervisor({
    tryConnect: async () => {
      tries++;
      return false;
    },
    probe: async () => false,
    isBusy: () => false,
    onLost: () => {},
  });
  sup2.start();
  await sleep(9000);
  sup2.stop();
  check('backs off instead of hammering', tries <= 5, tries + ' attempts in 9s');

  // 3. Notices the editor closing underneath an established connection.
  let lost = 0;
  let alive = true;
  const sup3 = new EditorSupervisor({
    tryConnect: async () => true,
    probe: async () => alive,
    isBusy: () => false,
    onLost: () => {
      lost++;
    },
  });
  sup3.setConnected(true);
  sup3.start();
  alive = false;
  await sleep(23000);
  sup3.stop();
  check('detects the editor closing via heartbeat', lost >= 1, 'onLost fired ' + lost + ' times');
}

function finish() {
  rmSync(root, { recursive: true, force: true });
  console.log('\n' + (failures === 0 ? 'Project detection OK.' : failures + ' check(s) FAILED.'));
  process.exitCode = failures === 0 ? 0 : 1;
}
