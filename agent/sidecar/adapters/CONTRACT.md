# Sidecar adapter contract

An adapter turns one CLI's private session log into Blackhouse's public event
union. It is the only file in the sidecar that is allowed to know what a
particular CLI writes to disk.

## The zero-effort option: write no adapter at all

**Emitting nothing is a supported configuration.** If `BLACKHOUSE_ADAPTER`
names a CLI with no adapter registered, the sidecar logs one line and exits 0.
The server then falls back to `server/agents/pty-scrape.ts`, which subscribes
to the PTY hub — it already has every byte the terminal ever printed — strips
ANSI, and emits coarse `turn_start` / `assistant_text` / `turn_end` events.

You get a working transcript for free, with these documented losses:

- No tool calls. The scraper sees rendered output, not structure, so it cannot
  tell `◇ Read src/db/schema.ts` from prose that happens to mention a file.
- No token or cost accounting, so budget caps do not apply to that agent.
- Weaker idle detection. The scraper only has the PTY-quiet clause, so it
  cannot tell "finished, waiting for you" from "sitting on a y/n permission
  prompt". A queued prompt released against a dialog answers the dialog.

That trade is often the right one. Write an adapter when the CLI has a real
structured log and the tool-level transcript is worth the maintenance.

## Writing an adapter

Add `agent/sidecar/adapters/<name>.mjs` and register it in the `ADAPTERS` map
in `agent/sidecar/index.mjs`. Node builtins and global `fetch` only — the
sidecar is fetched over the wire at boot and never gets an `npm install`.

The default export must provide:

| Member                 | Type                                               | Purpose                                                             |
| ---------------------- | -------------------------------------------------- | ------------------------------------------------------------------- |
| `name`                 | `string`                                           | Matches the `BLACKHOUSE_ADAPTER` value.                             |
| `profile`              | `{pollIntervalMs, idleQuietMs, heartbeatMs}`       | Timing, per adapter — not global constants. Tune these empirically. |
| `roots(env)`           | `(env) => string[]`                                | Directories to scan recursively for log files.                      |
| `fileFilter(path)`     | `(path) => boolean`                                | Which files in those directories are session logs.                  |
| `mapLine(input)`       | `({line, path, offset, seq}) => {events, nextSeq}` | The whole job. See below.                                           |
| `TERMINAL_EVENT_TYPES` | `Set<string>`                                      | Event types that mean "this turn is over".                          |

`mapLine` receives one complete line — the tailer holds partial trailing lines
until their newline arrives, so you never see half a record.

### Rules `mapLine` must obey

1. **Never throw.** Return a `raw` event instead. A thrown exception stops the
   tail loop and takes the entire transcript down; a `raw` event costs one
   ugly row. The sidecar wraps your call in a `try` anyway, but that net exists
   for bugs, not for design.
2. **Unknown entry type becomes `raw` carrying the whole object.** These log
   formats are undocumented and version-coupled. When the upstream CLI adds a
   record type, the correct behaviour is to keep going and show the operator
   something they can read, not to go quiet.
3. **Never emit a full tool input.** A single `Write` call can carry an entire
   file. Send a digest — byte count, key names, the few identifying fields the
   server needs to render a row — plus a preview clamped to 2 KB
   (`TOOL_INPUT_PREVIEW_LIMIT` in `server/agents/events.ts`). The server
   truncates again on ingest; do not rely on that.
4. **Never advance a watermark you did not successfully map.** The tailer owns
   offsets and only moves them past complete lines, so this mostly means: do
   not swallow a line by returning no events for it. If you understood nothing,
   say `raw`.
5. **`sourceRef` must be deterministic.** Ingest dedups on
   `(agentId, sourceRef)` with `ON CONFLICT DO NOTHING`, and the skip covers
   side effects too — no double-counted tokens, no re-posted messages. That is
   what lets the sidecar be stupid about delivery: replay after a restart, an
   offset rewind, or a retried batch all collapse. Prefer an id the CLI itself
   stamps per record (Claude Code writes a `uuid`); fall back to
   `sha1(path + ":" + offset)`. Where one line yields several events, suffix
   the index: `<base>:0`, `<base>:1`. Max 200 characters.
6. **`seq` is an ordering hint, not an identity.** It restarts at 0 when the
   container restarts. Never key anything on it.

### The event union

`turn_start`, `assistant_text`, `tool_use`, `tool_result`, `turn_end`,
`status`, `usage`, `raw`. Defined in `server/agents/events.ts`; the payload is
`.passthrough()`, so extra fields survive rather than being dropped.

What the server does with each:

- `assistant_text` — rendered as prose in the channel. Put the text in
  `payload.text`.
- `tool_use` — rendered as a collapsed activity row of glyph, verb, target and
  meta. Put the tool name in `payload.toolName`, the _reduced_ identifying
  fields in `payload.input`, and the human-readable right column in
  `payload.meta`. The server derives glyph and verb from the tool name.
- `tool_result`, `turn_start`, `turn_end` — activity rows.
- `usage` — never rendered; drives budget accounting. The server reads
  `costUsd`, `inputTokens` and `outputTokens` (snake_case also accepted). An
  agent whose adapter emits no `usage` events has no enforceable budget cap.
- `status`, `raw` — stored for provenance, never rendered.

### Activity

The sidecar computes idle as: session log quiet for `profile.idleQuietMs`
**and** the last non-bookkeeping event's type is in `TERMINAL_EVENT_TYPES`.
It POSTs that on every transition and at least every `profile.heartbeatMs`.

The server ANDs it with its own PTY-quiet clause before releasing a queued
prompt. Both halves are needed: the log goes quiet during a long `Bash` call
(busy but silent) and the PTY never goes quiet under a spinner (idle but
noisy).

Start in `unknown`, never `idle`. Claiming idle before the CLI has finished
booting releases a queued prompt into a splash screen.

## Testing an adapter without credentials

`tests/fixtures/mock-agent-tui.sh` is a fake TUI: it echoes injected stdin so
you can prove a prompt reached the PTY, and appends synthetic Claude-shaped
records to a session log so you can prove the adapter maps them. Paired with
`agent/dockerfiles/mock.Dockerfile` it exercises the whole slice — inject,
tail, map, post, render — with no agent API key anywhere.

Unit-test the mapping directly against fixture lines; see
`tests/unit/claude-jsonl-adapter.test.ts`.
