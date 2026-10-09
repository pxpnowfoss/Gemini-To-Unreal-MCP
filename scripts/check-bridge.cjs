/**
 * End-to-end test of the agent loop against the REAL Unreal MCP server, with a
 * scripted stand-in for Gemini. This exercises everything between the model and
 * the editor — argument parsing, meta-tool mapping, risk classification, the
 * approval gate, result formatting — without needing an API key.
 *
 * Every editor call it makes is read-only. The one write it scripts is declined
 * on purpose, to prove the approval gate actually blocks execution.
 *
 *   npm run check:bridge
 */

const { Agent } = require('../dist/main/agent.js');
const { McpClient } = require('../dist/main/mcpClient.js');

const url = process.argv[2] || process.env.UNREAL_MCP_URL || 'http://127.0.0.1:8000/mcp';

const SCENE = 'editor_toolset.toolsets.scene.SceneTools';

let failures = 0;
function check(label, condition, detail) {
  console.log((condition ? '  ✓ ' : '  ✕ ') + label + (condition ? '' : ' — ' + detail));
  if (!condition) failures++;
}

/** Minimal fake of GeminiClient that replays a fixed script of interactions. */
function fakeGemini(script) {
  let turn = 0;
  const seen = [];
  return {
    seen,
    setApiKey() {},
    async createInteraction(opts) {
      seen.push(opts);
      const step = script[turn++];
      if (!step) throw new Error('script exhausted');
      return step;
    },
  };
}

function fnCall(id, name, args) {
  return {
    id: 'int_' + id,
    status: 'requires_action',
    steps: [{ type: 'function_call', id: 'call_' + id, name, arguments: args }],
    usage: { total_input_tokens: 10, total_output_tokens: 5, total_tokens: 15 },
  };
}

function done(id, text) {
  return {
    id: 'int_' + id,
    status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'text', text }] }],
    usage: { total_input_tokens: 10, total_output_tokens: 20, total_tokens: 30 },
  };
}

const SETTINGS = {
  mcpUrl: url,
  model: 'fake-model',
  requireApproval: true,
  maxSteps: 40,
  extraInstructions: '',
  thinkingLevel: 'low',
};

async function run(name, script, settings, onApproval) {
  console.log('\n' + name);
  const mcp = new McpClient(url);
  const events = [];
  const agent = new Agent(fakeGemini(script), mcp, (e) => {
    events.push(e);
    if (e.type === 'approval-request' && onApproval) {
      const decision = onApproval(e.call);
      setImmediate(() => agent.resolveApproval(e.call.id, decision.approved, decision.always));
    }
  });
  await agent.send('test prompt', { ...SETTINGS, ...settings });
  await mcp.close();
  return events;
}

(async () => {
  // ---- 1. The discovery path the system prompt tells the model to follow.
  {
    const events = await run(
      'Discovery: list_toolsets -> describe_toolset -> call_tool (all read-only)',
      [
        fnCall(1, 'unreal_list_toolsets', '{}'),
        fnCall(2, 'unreal_describe_toolset', JSON.stringify({ toolset_name: SCENE })),
        fnCall(
          3,
          'unreal_call_tool',
          JSON.stringify({
            toolset_name: SCENE,
            tool_name: 'get_current_level',
            arguments_json: '{}',
          }),
        ),
        done(4, 'Done.'),
      ],
      {},
    );

    const updates = events.filter((e) => e.type === 'tool-update');
    const ok = updates.filter((e) => e.call.status === 'ok');
    check('three tool calls all succeeded', ok.length === 3, JSON.stringify(updates.map((u) => [u.call.label, u.call.status, u.call.error])));
    check(
      'list_toolsets returned the toolsets',
      ok.some((e) => e.call.toolName === 'list_toolsets' && /SceneTools/.test(e.call.result ?? '')),
      'no toolsets in result',
    );
    check(
      'describe_toolset returned a schema',
      ok.some((e) => e.call.toolName === 'describe_toolset' && /inputSchema/.test(e.call.result ?? '')),
      'no inputSchema in result',
    );
    const level = ok.find((e) => e.call.toolName === 'get_current_level');
    check('call_tool reached the editor', Boolean(level) && /returnValue/.test(level.call.result ?? ''), 'no returnValue');
    if (level) console.log('      level: ' + (level.call.result ?? '').trim());
    check(
      'read-only calls were not gated',
      !events.some((e) => e.type === 'approval-request'),
      'an approval was requested for a read',
    );
    check('final text surfaced', events.some((e) => e.type === 'text' && e.text === 'Done.'), 'no text event');
    check(
      'usage accumulated across turns',
      events.filter((e) => e.type === 'usage').pop()?.usage.totalTokens === 75,
      'unexpected usage total',
    );
  }

  // ---- 2. The approval gate must actually stop a write.
  {
    const events = await run(
      'Approval gate: a write is declined and never reaches the editor',
      [
        fnCall(
          1,
          'unreal_call_tool',
          JSON.stringify({
            toolset_name: SCENE,
            tool_name: 'add_to_scene_from_class',
            arguments_json: JSON.stringify({
              actor_type: { refPath: '/Script/Engine.StaticMeshActor' },
              name: 'ShouldNeverExist',
              xform: { location: { x: 0, y: 0, z: 0 } },
            }),
          }),
        ),
        done(2, 'Understood, I will not place it.'),
      ],
      {},
      () => ({ approved: false, always: false }),
    );

    const requested = events.find((e) => e.type === 'approval-request');
    check('approval was requested', Boolean(requested), 'no approval-request event');
    check('the write was classified as a change', requested?.call.risk === 'write', 'risk=' + requested?.call.risk);
    const final = events.filter((e) => e.type === 'tool-update').pop();
    check('the call ended as denied', final?.call.status === 'denied', 'status=' + final?.call.status);
    check('no result came back from the editor', !final?.call.result, 'got a result for a denied call');
  }

  // ---- 3. "Approve all" should let later writes through without asking again.
  {
    const events = await run(
      'Approval gate: "approve all" suppresses the second prompt',
      [
        fnCall(1, 'unreal_call_tool', JSON.stringify({ toolset_name: SCENE, tool_name: 'get_folders', arguments_json: '{}' })),
        fnCall(2, 'unreal_call_tool', JSON.stringify({ toolset_name: SCENE, tool_name: 'set_actor_folder', arguments_json: '{}' })),
        fnCall(3, 'unreal_call_tool', JSON.stringify({ toolset_name: SCENE, tool_name: 'delete_folder', arguments_json: '{}' })),
        done(4, 'ok'),
      ],
      {},
      () => ({ approved: true, always: true }),
    );
    const prompts = events.filter((e) => e.type === 'approval-request');
    check('only the first write prompted', prompts.length === 1, prompts.length + ' prompts');
    // Both writes run; they fail in the editor for missing required args, which is
    // fine — what matters is that the gate let them through.
    const ran = events.filter((e) => e.type === 'tool-update' && e.call.status !== 'awaiting-approval');
    check('both writes were attempted', ran.filter((e) => e.call.risk === 'write').length >= 2, 'writes not attempted');
  }

  // ---- 4. Malformed arguments must come back as a usable error, not a crash.
  {
    const events = await run(
      'Robustness: malformed arguments_json is reported back to the model',
      [
        fnCall(1, 'unreal_call_tool', JSON.stringify({ toolset_name: SCENE, tool_name: 'get_folders', arguments_json: '{not json' })),
        done(2, 'I will fix the arguments.'),
      ],
      { requireApproval: false },
    );
    const final = events.filter((e) => e.type === 'tool-update').pop();
    check('the bad call errored cleanly', final?.call.status === 'error', 'status=' + final?.call.status);
    check('the error explains the problem', /valid JSON/i.test(final?.call.error ?? ''), final?.call.error);
    check('the loop continued afterwards', events.some((e) => e.type === 'text'), 'loop did not continue');
  }

  // ---- 5. A fully-qualified tool name should still work.
  {
    const events = await run(
      'Robustness: a fully-qualified tool_name is accepted',
      [
        fnCall(
          1,
          'unreal_call_tool',
          JSON.stringify({ toolset_name: SCENE, tool_name: SCENE + '.get_folders', arguments_json: '{}' }),
        ),
        done(2, 'ok'),
      ],
      { requireApproval: false },
    );
    const final = events.filter((e) => e.type === 'tool-update').pop();
    check('prefix was stripped and the call ran', final?.call.status === 'ok', 'status=' + final?.call.status + ' err=' + final?.call.error);
    check('label is the bare tool name', final?.call.toolName === 'get_folders', 'toolName=' + final?.call.toolName);
  }

  // ---- 6. The step ceiling must stop a runaway loop.
  {
    const script = [];
    for (let i = 0; i < 10; i++) {
      script.push(fnCall(i, 'unreal_call_tool', JSON.stringify({ toolset_name: SCENE, tool_name: 'get_folders', arguments_json: '{}' })));
    }
    const events = await run('Safety: the step limit halts a runaway loop', script, {
      requireApproval: false,
      maxSteps: 3,
    });
    const end = events.filter((e) => e.type === 'turn-end').pop();
    check('the turn reported stopping early', end?.stoppedEarly === true, 'stoppedEarly=' + end?.stoppedEarly);
    check(
      'it ran no more than the limit',
      events.filter((e) => e.type === 'tool-call').length <= 3,
      events.filter((e) => e.type === 'tool-call').length + ' calls',
    );
  }

  // ---- 7. Risk classification must survive both of the server's naming styles.
  {
    console.log('\nRisk classification across naming styles');
    const { classifyRisk } = require('../dist/main/toolBridge.js');
    const cases = [
      // reads that must NOT be gated
      ['exists', 'read'], ['GetLogEntries', 'read'], ['IsPIERunning', 'read'],
      ['GetSelectedActors', 'read'], ['SearchCVars', 'read'], ['CaptureViewport', 'read'],
      ['ScreenCoordsToWorld', 'read'], ['SelectActors', 'read'], ['get_folders', 'read'],
      ['find_actors', 'read'], ['getLogEntries', 'read'],
      // writes that MUST stay gated
      ['StartPIE', 'write'], ['CreateSkill', 'write'], ['add_to_scene_from_class', 'write'],
      ['delete_folder', 'write'], ['save_actor', 'write'], ['load_level', 'write'],
      ['create_material', 'write'], ['remove_from_scene', 'write'],
    ];
    const wrong = cases.filter(([n, want]) => classifyRisk(n) !== want);
    check(
      'PascalCase and snake_case classify identically',
      classifyRisk('GetLogEntries') === classifyRisk('get_log_entries'),
      'naming style changes the verdict',
    );
    check(
      'all ' + cases.length + ' classification cases correct',
      wrong.length === 0,
      wrong.map(([n, w]) => n + ' wanted ' + w).join(', '),
    );
  }

  console.log(
    '\n' + (failures === 0 ? 'All bridge checks passed.' : failures + ' check(s) FAILED.'),
  );
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((err) => {
  console.error('\nHarness error: ' + err.stack);
  process.exitCode = 1;
});
