# Gemini → Unreal

A Windows desktop app that lets you sign in with your Gemini API key and then build
inside a running Unreal Editor by asking for it in plain language. Gemini drives the
editor through its MCP server: placing actors, editing assets, authoring Blueprints,
reading the output log — anything the editor's toolsets expose.

```
┌──────────────┐   HTTPS    ┌─────────────┐   Streamable HTTP   ┌────────────────┐
│  This app    │ ─────────► │ Gemini API  │                     │ Unreal Editor  │
│  (Electron)  │ ◄───────── │ Interactions│                     │  MCP server    │
│              │            └─────────────┘                     │ 127.0.0.1:8000 │
│              │ ──────────────── MCP tool calls ──────────────► │                │
└──────────────┘                                                └────────────────┘
```

The app is the MCP client. Gemini never talks to your editor directly — it asks the
app to run a tool, the app runs it locally and sends back the result. Your project
data stays on your machine, and every change can be gated behind an approval prompt.

> **Why not point Gemini straight at the MCP server?** The Interactions API can
> connect to remote MCP servers itself (`type: "mcp_server"`), but only ones Google's
> servers can reach over the public internet. An editor on `127.0.0.1` is not one of
> them, so the app bridges the calls locally instead. That is also the private option.

## Requirements

- Windows 10/11, Node.js 20+
- Unreal Engine 5.8 with the MCP plugin enabled, a project open
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)

## Setup

```bash
npm install
npm run build
npm start
```

If `npm install` reports that install scripts were blocked, Electron's binary will be
missing. Fetch it with:

```bash
node node_modules/electron/install.js
```

On first launch the app walks you through two steps:

1. **Settings → Gemini account** — paste your API key and press *Verify & save*. The
   key is checked against the API before it is stored, so a typo never gets saved as
   working. It is then encrypted with `safeStorage` (Windows DPAPI, scoped to your
   user account) and written to `%APPDATA%/gemini-to-unreal-mcp/config.json`.
2. **Settings → Unreal Editor** — confirm the endpoint (default
   `http://127.0.0.1:8000/mcp`) and press *Connect*. The pill in the title bar turns
   green and shows how many toolsets were found.

## Sessions

Work is organised into sessions. Each one keeps its own conversation, its own token
and request count, its own linked folder, and the Gemini thread id — so reopening a
session resumes the same conversation rather than starting over. The app restores the
session you last used on launch.

- **New** in the title bar starts a fresh session. An untitled session names itself
  after your first message; click the title in the session bar to rename it.
- **Sessions** opens the list: switch, rename or delete. Deleting the last one
  immediately creates an empty replacement, so there is always a session open.
- **Start <Project>** appears in the session bar when the linked folder holds a
  `.uproject` and the editor is not up. It opens the project through Unreal's own
  version selector, so the right engine build is chosen for you.
- **Link a folder** ties a session to a directory — normally the `.uproject` folder of
  the project you are working on. The path is shown in the session bar and is given to
  Gemini as context, so "this project" and bare filenames resolve there, and the asset
  toolset can read files from it.

Sessions live as one JSON file each under `%APPDATA%/gemini-to-unreal-mcp/sessions/`,
written with a short debounce and flushed on switch and on quit. A transcript is capped
at 2000 entries so a long-running session cannot grow without bound.

```bash
electron . --diagnose-sessions    # round-trips a session through disk and reports
```

## Staying connected to the linked project

The MCP server lives inside the editor, so there is nothing to talk to while Unreal is
closed. Rather than failing until you press Connect, the app supervises the link:

- While disconnected it retries quietly in the background (immediately, then backing
  off to a 5-second ceiling) and connects the moment the editor appears. The status
  pill reads *Waiting for the editor…* in the meantime.
- While connected it heartbeats every 20 seconds, so closing Unreal is noticed within
  about that long rather than at your next message. The agent's own traffic counts as
  proof of life, so an active turn is never interrupted by a probe.
- After connecting it compares the editor's open project against the session's linked
  folder, by reading the `.uproject` from each running editor's command line. If they
  differ the pill says **Different project open** — without that, Gemini would happily
  build in whichever project happened to be running.

A folder containing several projects side by side (`C:\Dev`, say) is treated as *no*
project rather than guessing one of them.

## Using it

Type what you want. Gemini discovers the editor's capabilities as it goes:
`list_toolsets` to see what exists, `describe_toolset` to read the exact argument
schemas, then `call_tool` to do the work. Every call appears in the transcript as a
card you can expand to see the arguments and the raw result.

Things worth asking for:

- "What's in the current level? Group anything unparented into folders by type."
- "Place a row of five cubes 300 units apart along X, in a folder called Blockout."
- "Find every point light with intensity over 5000 and halve it."
- "Make a material instance of M_Base with the tint set to red and apply it to the selected actors."
- "Read the output log and tell me what's erroring."

### Approvals

**Ask before changes** is off by default, so Gemini builds without interruption. With it
on, anything that can modify your project waits for you. Reads — `get_*`, `find_*`, `describe_*`, `trace_*` and friends — run
without prompting, so exploration stays fast. Each prompt offers *Approve*, *Approve
all* (for the rest of the conversation) or *Decline*; declining tells Gemini not to
retry and to ask you what you'd prefer instead.

Classification is by verb, because the server exposes hundreds of tools with no
machine-readable risk annotation. It errs toward calling things writes.

### Settings

| Setting | What it does |
| --- | --- |
| Model | Populated live from your key's model list. **On the free tier pick a Flash-Lite model** (`gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`): full Flash models are capped near 20 requests/day, which this app can spend in two or three turns. `gemini-3.8-flash` or `gemini-3.1-pro-preview` are better once billing is enabled. |
| Reasoning effort | Maps to `thinking_level`. High is worth it for anything structural. |
| Ask before changes | The approval gate described above. **Off by default** — Gemini builds without stopping. Turn it on when you want to review each change first. |
| Step limit | How many model↔tool round trips one message may take before it pauses. Stops runaway loops. |
| Project instructions | Appended to the system prompt every message — naming conventions, folder layout, paths Gemini must never touch. |

## Diagnostics

```bash
npm run ui:harness     # chat UI in a browser with a stubbed backend, no key needed
npm run check:unreal   # can we reach the editor, and what does it expose?
npm run check:bridge   # end-to-end agent-loop test against the live editor
npm run check:retry    # overload/rate-limit handling (stubbed, no API key needed)
npm run check          # all three
```

`check:unreal` is the one to run when something isn't working — it tells you whether
the problem is the editor or Gemini. `check:bridge` replays a scripted conversation
through the real agent loop against your real editor, covering tool discovery, the
approval gate, malformed arguments and the step ceiling. Every editor call it makes is
read-only; the one write it scripts is declined on purpose to prove the gate holds.

## Request budget

Every model↔tool round trip is one API request, and a single instruction ("place a red
cube") typically costs five to ten. That matters because free-tier quotas are counted in
**requests per day**, not tokens — full Flash models sit around 20 RPD, while Flash-Lite
models are in the hundreds. Limits apply **per Google Cloud project, not per API key**, so
a second key from the same project shares the same budget, and RPD resets at midnight
Pacific.

The pill in the title bar shows requests before tokens (`12 req · 5.2k tok`) because the
request count is what runs out first.

To get more headroom, in rough order of effort: pick a Flash-Lite model, enable billing on
the key's project, or use a key from a different project.

## Troubleshooting

**"Cannot reach the Unreal MCP server"** — the plugin is per-project and off by
default. The project must be the one *currently open*; only that editor instance binds
the port. Enable it with Edit → Plugins → **Unreal MCP**, restart, and make sure the
project's `Config/DefaultEditorPerProjectUserSettings.ini` has:

```ini
[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]
ServerUrlPath=/mcp
ServerPortNumber=8000
```

Run `npm run check:unreal` to confirm the editor side on its own.

**It sits on "thinking…" for a long time.** That is usually real work, not a hang. At
`thinking_level: high` a single step can take 60–90 seconds, and a build takes many
steps. The status line shows the step number and elapsed time so you can tell progress
from a stall, and a request that genuinely goes quiet fails after five minutes rather
than hanging forever. Dropping **Reasoning effort** to Low or Medium makes each step
dramatically faster; keep High for structural work.

You can watch what the editor is actually being asked to do from Unreal's own log —
filter the output log on `LogModelContextProtocol`.

**"Gemini is overloaded (503)."** The model is busy on Google's side. The client
rides this out automatically: up to five retries, honouring `Retry-After` when the
server sends one and otherwise backing off exponentially with jitter, with the wait
shown in the status line. If it still fails, wait a few minutes or pick a different
model in Settings — `gemini-3.1-pro-preview` and `gemini-3.8-flash` rarely peak
together. Pressing Stop interrupts a backoff immediately.

**"Gemini will not accept more requests for about 7h."** That is a quota, not a busy
server: the API sent a `Retry-After` measured in hours, which on the free tier means
the daily cap for that model is spent. Quotas are counted per model, so switching
model in Settings usually gets you going again; otherwise wait for the reset or
enable billing on the key's project. The app refuses to sit on a wait this long —
anything over 90 seconds fails immediately with the reset time instead.

**"Your saved key could not be decrypted."** `safeStorage`'s AES key lives in
Chromium's `Local State`; if that is rotated or replaced, previously saved ciphertext
becomes unreadable. The app detects this, clears the dead value and asks you to paste
the key again rather than claiming a key is saved while every request fails.

Two diagnostics are built in:

```bash
electron . --diagnose-credentials     # is a saved key present, and is it usable?
electron . --crypto-roundtrip write   # then:
electron . --crypto-roundtrip read    # does encryption survive a restart here?
```

## Packaging

```bash
npm run dist     # NSIS installer in release/
```

## Layout

```
src/
  main/
    main.ts          Window, IPC, startup wiring
    store.ts         Settings + API key encrypted via safeStorage
    mcpClient.ts     Streamable-HTTP MCP client (session handling, reconnect, SSE)
    geminiClient.ts  Interactions API client
    toolBridge.ts    Function declarations + the Unreal system prompt
    agent.ts         The model↔tool loop, approvals, cancellation
  preload/preload.ts The only renderer↔Node bridge
  renderer/          UI (no credentials, no network)
  shared/types.ts    Types used by both sides
```

### Notes on the implementation

- **Stateful tool loop.** Each turn passes `previous_interaction_id` rather than
  replaying the transcript. Thinking models return thought signatures that must
  survive the round trip, and hand-replaying them is the usual cause of broken tool
  loops — this avoids the problem entirely and keeps requests small.
- **Three tools, not three hundred.** The editor exposes ~19 toolsets behind
  `list_toolsets` / `describe_toolset` / `call_tool`. The app declares just those
  three to Gemini. The docs advise keeping the active set to 10–20 declarations, and
  Unreal's nested schemas would exceed the OpenAPI subset the API accepts, so runtime
  discovery is both necessary and cheaper.
- **Arguments as a JSON string.** `call_tool`'s payload shape is only known after
  `describe_toolset`, so it is declared as a `string` of JSON (`arguments_json`) and
  parsed in the app. Declaring an open-ended object there is unreliable; this is not.
  The parser tolerates double-encoding and fully-qualified tool names, both of which
  models produce in practice.
- **Security.** `contextIsolation` on, `nodeIntegration` off, a CSP on the renderer,
  external links forced out to the system browser, and the API key never crosses into
  the renderer or appears in a URL.

## Limits

- Responses are not token-streamed. The loop reports each step as it happens — thought
  summaries, tool calls, results — so there is continuous feedback, but text arrives a
  block at a time. Streaming would need the `?alt=sse` delta-aggregation path.
- Image results from editor tools (viewport captures) are noted but not displayed.
- Undo is Unreal's, not the app's. Ctrl+Z in the editor still works, but a saved asset
  or a loaded level is not something the app can take back — hence the approval gate.
