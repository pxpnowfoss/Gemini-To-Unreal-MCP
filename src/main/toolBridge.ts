/**
 * Bridges the Unreal MCP server's three meta-tools into Gemini function declarations.
 *
 * The Unreal server deliberately exposes only `list_toolsets`, `describe_toolset`
 * and `call_tool`, behind which sit 19 toolsets and several hundred individual
 * tools with deeply nested schemas. That shape suits Gemini well: the docs advise
 * keeping the active tool set to 10-20 declarations, and the nested Unreal schemas
 * would blow past the OpenAPI subset the API accepts. So we hand the model the
 * three meta-tools and let it discover the rest at runtime.
 *
 * One deliberate deviation: `call_tool`'s `arguments` is an open-ended object whose
 * shape is known only after `describe_toolset`. Rather than declare an object with
 * no properties, we declare `arguments_json` as a *string* holding JSON and parse it
 * here. That sidesteps the schema subset entirely and is far more reliable in
 * practice than asking the model to fill a free-form object.
 */

import type { FunctionDeclaration } from './geminiClient';
import type { ToolRisk } from '../shared/types';
import { gitRisk } from './gitTools';

export const TOOL_LIST_TOOLSETS = 'unreal_list_toolsets';
export const TOOL_DESCRIBE_TOOLSET = 'unreal_describe_toolset';
export const TOOL_CALL_TOOL = 'unreal_call_tool';

const GIT_DECLARATIONS: FunctionDeclaration[] = [
  {
    type: 'function',
    name: 'git_status',
    description:
      'Show the branch, working-tree changes and configured remotes of the git repository ' +
      'in the folder linked to this session. Call this before committing or pushing so you ' +
      'know what is actually changed.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'git_log',
    description: 'List recent commits in the linked repository, newest first.',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'integer', description: 'How many commits to list. Defaults to 20.' },
      },
    },
  },
  {
    type: 'function',
    name: 'git_diff',
    description:
      'Show what has changed in the linked repository. Returns a per-file summary by default; ' +
      'ask for the full patch only when you need to read the actual edits.',
    parameters: {
      type: 'object',
      properties: {
        staged: { type: 'boolean', description: 'Diff what is staged rather than the working tree.' },
        name_only: {
          type: 'boolean',
          description: 'True (default) for a file summary, false for the full patch.',
        },
      },
    },
  },
  {
    type: 'function',
    name: 'git_commit',
    description:
      'Stage and commit changes in the linked repository. Stages everything unless you name ' +
      'specific paths. Write a real commit message describing what changed and why.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The commit message.' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional specific paths to stage. Omit to stage every change.',
        },
      },
      required: ['message'],
    },
  },
  {
    type: 'function',
    name: 'git_push',
    description:
      'Push the current branch to a remote, setting upstream if it has none. This PUBLISHES ' +
      'the commits — on a public repository anyone can then read them. Check git_status first ' +
      'and make sure the user wants this.',
    parameters: {
      type: 'object',
      properties: {
        remote: { type: 'string', description: 'Remote name. Defaults to "origin".' },
      },
    },
  },
  {
    type: 'function',
    name: 'git_init',
    description:
      'Create a git repository in the linked folder, if it is not one already.',
    parameters: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Initial branch name. Defaults to "main".' },
      },
    },
  },
  {
    type: 'function',
    name: 'git_set_remote',
    description:
      'Point the linked repository at a remote URL, adding it or updating it in place.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'An https:// or git@ remote URL.' },
        name: { type: 'string', description: 'Remote name. Defaults to "origin".' },
      },
      required: ['url'],
    },
  },
];

export function buildFunctionDeclarations(): FunctionDeclaration[] {
  return [
    ...GIT_DECLARATIONS,
    {
      type: 'function',
      name: TOOL_LIST_TOOLSETS,
      description:
        'List every Unreal Editor toolset available in the running editor, with a short ' +
        'description of each. Call this first when you do not yet know which toolset holds ' +
        'the capability you need.',
      parameters: { type: 'object', properties: {} },
    },
    {
      type: 'function',
      name: TOOL_DESCRIBE_TOOLSET,
      description:
        'Describe one Unreal toolset: every tool it contains, each tool\'s purpose, and the ' +
        'exact JSON input schema for its arguments. You MUST describe a toolset before ' +
        'calling any tool inside it, so that your arguments match the real schema.',
      parameters: {
        type: 'object',
        properties: {
          toolset_name: {
            type: 'string',
            description:
              'Fully qualified toolset name exactly as returned by ' +
              TOOL_LIST_TOOLSETS +
              ', e.g. "editor_toolset.toolsets.scene.SceneTools".',
          },
        },
        required: ['toolset_name'],
      },
    },
    {
      type: 'function',
      name: TOOL_CALL_TOOL,
      description:
        'Execute one Unreal Editor tool against the live editor. This performs real work in ' +
        'the user\'s open project. Only call this after ' +
        TOOL_DESCRIBE_TOOLSET +
        ' has shown you the tool\'s input schema.',
      parameters: {
        type: 'object',
        properties: {
          toolset_name: {
            type: 'string',
            description:
              'The toolset that contains the tool, e.g. "editor_toolset.toolsets.scene.SceneTools". ' +
              'Omit only for a top-level tool that belongs to no toolset.',
          },
          tool_name: {
            type: 'string',
            description:
              'The tool name WITHOUT its toolset prefix, e.g. "add_to_scene_from_class" — ' +
              'not "editor_toolset.toolsets.scene.SceneTools.add_to_scene_from_class".',
          },
          arguments_json: {
            type: 'string',
            description:
              'The tool arguments as a JSON object encoded in a string, matching the input ' +
              'schema from ' +
              TOOL_DESCRIBE_TOOLSET +
              ' exactly. Example: ' +
              '"{\\"asset_path\\":\\"/Game/Meshes/SM_Cube\\",\\"name\\":\\"Cube_01\\",' +
              '\\"xform\\":{\\"location\\":{\\"x\\":0,\\"y\\":0,\\"z\\":100}}}". ' +
              'Pass "{}" when the tool takes no arguments.',
          },
        },
        required: ['tool_name', 'arguments_json'],
      },
    },
  ];
}

/**
 * Reads are safe to run unattended; everything else can change the user's project
 * and is gated behind approval when that setting is on. We classify by verb because
 * the server exposes hundreds of tools and has no machine-readable risk annotation.
 */
const READ_ONLY_PREFIXES = [
  'get',
  'find',
  'list',
  'describe',
  'read',
  'search',
  'query',
  'is',
  'are',
  'can',
  'has',
  'does',
  'should',
  'trace',
  'export',
  'resolve',
  'validate',
  'verify',
  'compute',
  'calculate',
  'exists',
  'contains',
  'count',
  'num',
  'fetch',
  'inspect',
  'check',
  'capture',
  'screenshot',
  'preview',
  'diff',
];

/**
 * Tools that change what the editor is *looking at* without changing the project.
 * Gating these would fire a prompt for nearly every navigation step, which trains
 * the user to hit "Approve all" and makes the gate worthless for the calls that
 * genuinely matter.
 */
const NON_MUTATING_EXACT = new Set([
  'list_toolsets',
  'describe_toolset',
  // The wrapper names the model actually sees. Discovery never changes anything;
  // `unreal_call_tool` stays a write because its risk depends on the inner tool.
  'unreal_list_toolsets',
  'unreal_describe_toolset',
  'select_actors',
  'select_assets',
  'focus_on_actors',
  'set_camera_transform',
  'set_content_browser_path',
  'open_editor_for_asset',
  'screen_coords_to_world',
  'world_pos_to_screen_coords',
]);

/**
 * Normalises `GetLogEntries`, `get_log_entries` and `getLogEntries` to the same
 * token list. The Unreal server mixes PascalCase and snake_case across toolsets,
 * and matching one style silently misclassified every tool in the other.
 */
function toWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean);
}

export function classifyRisk(toolName: string): ToolRisk {
  // Git verbs do not follow Unreal's naming, and "git_status" would otherwise be
  // read as a write because it starts with "git".
  if (toolName.startsWith('git_')) return gitRisk(toolName);

  const bare = toolName.includes('.') ? toolName.slice(toolName.lastIndexOf('.') + 1) : toolName;
  const words = toWords(bare);
  const normalised = words.join('_');

  if (NON_MUTATING_EXACT.has(normalised)) return 'read';
  if (words.length && READ_ONLY_PREFIXES.includes(words[0])) return 'read';
  return 'write';
}

/** Parses the model's `arguments_json` string, tolerating a pre-parsed object. */
export function parseArgumentsJson(value: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  if (value === undefined || value === null || value === '') return { ok: true, args: {} };

  if (typeof value === 'object' && !Array.isArray(value)) {
    return { ok: true, args: value as Record<string, unknown> };
  }

  if (typeof value !== 'string') {
    return { ok: false, error: 'arguments_json must be a JSON object encoded as a string.' };
  }

  const trimmed = value.trim();
  if (!trimmed) return { ok: true, args: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return {
      ok: false,
      error:
        'arguments_json was not valid JSON (' +
        (err as Error).message +
        '). Send a JSON object encoded as a string, e.g. "{\\"name\\":\\"Cube\\"}".',
    };
  }

  // Models sometimes double-encode the string.
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return { ok: false, error: 'arguments_json decoded to a string rather than a JSON object.' };
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'arguments_json must decode to a JSON object, not an array or scalar.' };
  }

  return { ok: true, args: parsed as Record<string, unknown> };
}

const SYSTEM_INSTRUCTION = [
  'You are an Unreal Engine technical artist operating a LIVE Unreal Editor session through',
  'a set of tools. The project is open on the user\'s machine and your tool calls take effect',
  'immediately in their editor. Work like a careful collaborator on someone else\'s project.',
  '',
  '## How to use the tools',
  '',
  'You have three tools and they are meant to be used in order:',
  '',
  '1. `' + TOOL_LIST_TOOLSETS + '` — see which toolsets exist (scene, actor, asset, blueprint,',
  '   material, static_mesh, texture, data_table, editor app, logs, and more).',
  '2. `' + TOOL_DESCRIBE_TOOLSET + '` — read the tools in a toolset and their exact JSON input',
  '   schemas. Never call a tool whose schema you have not read in this conversation; the',
  '   schemas are specific and guessing wastes turns.',
  '3. `' + TOOL_CALL_TOOL + '` — run a tool. Pass `arguments_json` as a JSON object encoded in a',
  '   string that matches the schema exactly.',
  '',
  'Describe a toolset once and remember its schemas for the rest of the conversation.',
  '',
  '## Unreal conventions that the schemas assume',
  '',
  '- **Units and axes.** Distances are centimetres. Z is up. X is forward, Y is right.',
  '  Rotations are degrees, given as `{"pitch":0,"yaw":0,"roll":0}`.',
  '- **Object and class references** are objects of the form `{"refPath":"<soft path>"}`, never',
  '  bare strings. An actor you got back from a previous call must be passed on in exactly the',
  '  form you received it. Class references look like `{"refPath":"/Script/Engine.StaticMeshActor"}`',
  '  or, for a Blueprint class, `{"refPath":"/Game/Blueprints/BP_Door.BP_Door_C"}`.',
  '- **Transforms** use the `ToolsetTransform` shape: `{"location":{"x":..,"y":..,"z":..},',
  '  "rotation":{"pitch":..,"yaw":..,"roll":..},"scale":{"x":..,"y":..,"z":..}}`. Omitted fields',
  '  mean identity when creating and "leave unchanged" when modifying.',
  '- **Asset paths** are content paths like `/Game/Meshes/SM_Rock`, not filesystem paths.',
  '- Some tools mark filter arguments as required even when they are optional in spirit',
  '  (`find_actors` requires `name`, `tag` and `collision_channels`). Pass `""` and `[]` for the',
  '  filters you do not want to apply.',
  '',
  '## Source control',
  '',
  'You also have git tools — `git_status`, `git_log`, `git_diff`, `git_commit`, `git_push`,',
  '`git_init`, `git_set_remote` — which run against the folder linked to this session, not',
  'the editor. Use them when the user asks to commit, push, or check what has changed.',
  '',
  '- **Look before you commit.** Run `git_status` and `git_diff` first and tell the user what',
  '  you are about to include. Never commit blind.',
  '- **Save Unreal work first.** Assets and levels live in memory until saved; committing',
  '  before saving captures a stale tree. Save through the editor, then commit.',
  '- **Write real commit messages** describing what changed and why, not "update".',
  '- **Pushing publishes.** On a public repository the commits become readable by anyone, and',
  '  they cannot be unpublished. Confirm the user wants it, and never push something you only',
  '  assumed they wanted committed.',
  '- Binary Unreal content makes for large commits. If the diff looks enormous or sweeps in',
  '  `Saved/`, `Intermediate/`, `Binaries/` or `DerivedDataCache/`, say so — the repository',
  '  probably needs a .gitignore before anything is committed.',
  '- Credentials are not yours to handle. If a push fails on authentication, report the',
  '  error from git and let the user sort out their credential helper.',
  '',
  '## Recipes that are easy to get wrong',
  '',
  '**Giving something a solid colour.** Creating a material and wiring a node is not',
  'enough — a new colour node defaults to BLACK, so the object renders black (or',
  'unchanged) unless you explicitly set its value. The full sequence is:',
  '',
  '1. `MaterialTools.create_material(folder_path, asset_name)`.',
  '2. `MaterialTools.add_expression(material, expression_class, x, y)` with',
  '   `MaterialExpressionConstant3Vector` (or `MaterialExpressionVectorParameter`).',
  '3. **Set the colour.** MaterialTools has no value setter — use',
  '   `ObjectTools.set_properties(instance, values)` on the expression you just added.',
  '   Call `ObjectTools.list_properties` on it first to get the exact property name',
  '   (`Constant` for Constant3Vector, `DefaultValue` for VectorParameter). Red is',
  '   `{"r":1,"g":0,"b":0,"a":1}`. Skipping this step is the single most common reason',
  '   a "red" object comes out black.',
  '4. `MaterialTools.connect_to_output(expression, output_name, material_property)` with',
  '   the base-colour property.',
  '5. `MaterialTools.recompile(material)` — the graph is not live until you do.',
  '6. `AssetTools.save_assets([...])` so the material survives.',
  '7. Assign it: `ObjectTools.set_properties` on the mesh **component** (not the actor),',
  '   setting its material override array. `ActorTools.get_components` finds the',
  '   component; `ObjectTools.list_properties` gives you the array\'s name.',
  '8. Read the property back to confirm the assignment stuck.',
  '',
  '**Placing a simple shape.** Prefer `SceneTools.add_to_scene_from_asset` with an',
  'existing mesh such as `/Engine/BasicShapes/Cube`, which gives you a StaticMeshActor',
  'with a real mesh and a material slot. Building an actor out of bare components is',
  'more steps and leaves you with nothing to assign a material to.',
  '',
  '**Where to put it.** Never spawn at the origin or at the editor camera\'s own',
  'position — the camera ends up inside the object and the user sees nothing. Read the',
  'camera transform from the editor app toolset and place the actor a few hundred',
  'units *in front of* it, or use `snap_to_ground`, then confirm with',
  '`ActorTools.get_actor_bounds` that it is somewhere visible. Focusing the viewport on',
  'the new actor afterwards is a good finishing touch.',
  '',
  '## Working method',
  '',
  '- **Look before you build.** Check the current level, find existing actors, and list relevant',
  '  assets before placing anything. Do not invent asset paths — search for them. If an asset you',
  '  need does not exist, say so rather than silently substituting something else.',
  '- **Verify after you act.** After a mutation, read the state back and confirm the result',
  '  matches the intent — not merely that the call returned without error. A call can succeed',
  '  and still leave the object black, invisible, or in the wrong place. Check the thing the',
  '  user actually asked for: the colour property, the transform, the bounds.',
  '- **Do not claim success you have not checked.** If you report placing a red cube, you',
  '  should have read back both that the actor exists where you expect and that its material',
  '  carries the colour you set.',
  '- **Name things deliberately.** Give actors meaningful labels and group related actors into',
  '  outliner folders so the user can find and undo your work.',
  '- **Prefer the ProgrammaticToolset** when a task needs many similar calls (placing fifty',
  '  instances, retargeting materials across a folder). One orchestrated script is faster and far',
  '  easier for the user to follow than fifty separate calls.',
  '- **Check the logs** via the Logs toolset when something fails without a clear error.',
  '',
  '## Care with the user\'s project',
  '',
  '- Deleting actors or assets, saving, loading a different level, and running console commands',
  '  are not reversible from your side. Explain what you are about to do before doing it, and do',
  '  the minimum the request calls for.',
  '- If a request is ambiguous in a way that changes what gets built — which level, which mesh,',
  '  how many — ask one short question instead of guessing.',
  '- If a tool returns an error, read it, fix the arguments, and retry. After two failed attempts',
  '  at the same thing, stop and explain what is blocking you.',
  '',
  '## Replying to the user',
  '',
  'Keep prose short. Say what you did, where it is in the level or content browser, and what you',
  'would suggest next. The user can see every tool call and its result in the UI, so do not',
  'narrate each one or paste raw tool output back at them.',
].join('\n');

export function buildSystemInstruction(extra: string, folderPath?: string | null): string {
  let out = SYSTEM_INSTRUCTION;

  if (folderPath) {
    out +=
      '\n\n## Folder linked to this session\n\n' +
      'The user has linked this session to `' +
      folderPath +
      '`. Treat it as the project this conversation is about. When a request mentions ' +
      '"the project", "this project" or a file without a path, resolve it there first. ' +
      'The asset toolset can read and write files on disk, so you can inspect that folder ' +
      'directly — but stay inside it unless the user names somewhere else.';
  }

  const trimmed = (extra ?? '').trim();
  if (trimmed) out += '\n\n## Project-specific instructions from the user\n\n' + trimmed;

  return out;
}
