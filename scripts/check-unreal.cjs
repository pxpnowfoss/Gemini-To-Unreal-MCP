/**
 * Connection diagnostic. Talks to the Unreal MCP server with the same client the
 * app uses, so a failure here tells you the problem is the editor, not Gemini.
 *
 *   npm run check:unreal
 *   npm run check:unreal -- http://127.0.0.1:8000/mcp
 */

const { McpClient } = require('../dist/main/mcpClient.js');

const url = process.argv[2] || process.env.UNREAL_MCP_URL || 'http://127.0.0.1:8000/mcp';

function parseToolsetNames(text) {
  const names = [];
  for (const line of text.split('\n')) {
    const m = /^\s*[-*]?\s*([A-Za-z_][\w.]*(?:\.[A-Za-z_]\w*)+)\s*:/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

(async () => {
  console.log('Connecting to ' + url + ' …\n');
  const client = new McpClient(url);

  try {
    await client.connect();
    console.log('✓ Session established');

    const tools = await client.listTools();
    console.log('✓ Top-level tools: ' + tools.map((t) => t.name).join(', '));

    const expected = ['list_toolsets', 'describe_toolset', 'call_tool'];
    const missing = expected.filter((e) => !tools.some((t) => t.name === e));
    if (missing.length) {
      console.log('! Missing expected meta-tools: ' + missing.join(', '));
    }

    const listed = await client.callTool('list_toolsets', {});
    const toolsets = parseToolsetNames(listed.text);
    console.log('✓ Toolsets discovered: ' + toolsets.length);
    for (const name of toolsets) console.log('    ' + name);

    // A read-only probe that proves call_tool reaches the editor.
    console.log('\nProbing the current level (read-only)…');
    const probe = await client.callTool('call_tool', {
      toolset_name: 'editor_toolset.toolsets.scene.SceneTools',
      tool_name: 'get_current_level',
      arguments: {},
    });
    console.log((probe.isError ? '! ' : '✓ ') + probe.text.trim());

    await client.close();
    console.log('\nAll good — the app will be able to drive this editor.');
  } catch (err) {
    console.error('\n✕ ' + err.message);
    console.error(
      '\nChecklist:\n' +
        '  1. Unreal Editor is running with a project open.\n' +
        '  2. The MCP plugin is enabled and listening.\n' +
        '  3. The port matches (default 8000) and nothing else is bound to it.\n',
    );
    process.exitCode = 1;
  }
})();
