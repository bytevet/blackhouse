# Blackhouse → Multi-Agent Harness

## Context

Blackhouse today manages **coding sessions**: one user spawns a container, gets a TUI, an IDE tab, a
browser tab, and an HTML result pane. Agents can already DM each other through a durable inbox
(`session_messages` + `send-msg.sh` / `check-inbox.sh`), but the model is session-centric — there is no
notion of a persistent agent identity, no shared conversation, and no way to `@mention` a teammate.

We want a **harness**: a Slack-like workspace where persistent named agents (`@reviewer`, `@backend`)
sit in channels alongside humans. Mentioning an agent injects the prompt into its **live TUI** — you can
attach and watch it work. A structured sidecar streams what the agent does back into the channel as a
readable transcript. Agents may mention each other, but every agent→agent dispatch is human-approved.

Second driver: agents currently run in plain Docker containers with 2GB/2CPU limits and no other
hardening — they run untrusted model-authored code with a shared Docker socket in the blast radius.
We want a **pluggable sandbox runtime** so gVisor (`runsc`) is the default on Linux, Kata is a designed-for
future, and plain `runc` remains the graceful fallback for local macOS/Podman development.

**Outcome:** a runnable vertical slice — create agent → container starts through the sandbox abstraction →
channel UI → `@mention` injects into the live TUI → sidecar streams the transcript back → attach and watch.

> **Status: one open decision blocks the client work** — see "Design system conflict" below. The server
> phases (0–2) are unaffected and ready to build.

## Decisions (settled in the interview)

| Area            | Decision                                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scope           | Greenfield rewrite of the domain model; same repo, name, and stack                                                                                                                         |
| Agent model     | Persistent named personas with durable identity + workspace. **No hibernation in v1**                                                                                                      |
| Mention → TUI   | Inject into the live TUI. Per message: **queue-until-idle** (default) or **interrupt-then-inject**                                                                                         |
| Agent ↔ agent   | Mention-driven, **human-gated** via an inline approve/deny card in the channel                                                                                                             |
| Channels        | Flat; agents joined ad hoc. **Channels replace the DM inbox**                                                                                                                              |
| Transcript      | Structured sidecar. Rich for Claude Code, degraded PTY-scrape for others, documented BYO contract                                                                                          |
| Sandbox         | Pluggable driver interface. `runsc` default on Linux, hardened `runc` fallback, Kata as a stub                                                                                             |
| Egress          | Per-agent policy `none` \| `allowlist` \| `open`, default allowlist via harness proxy                                                                                                      |
| Workspace       | Per-agent repo checkout + per-agent state volume. **No shared scratch** — agents hand off via channel artifacts and git                                                                    |
| Hosts           | Linux VPS (bare metal / nested virt) **and** local macOS/Docker Desktop/Podman                                                                                                             |
| Users           | Small team, shared instance. Keep Better Auth. No orgs/tenants/quotas                                                                                                                      |
| Keep            | Terminal/TUI attach, code-server IDE tab, embedded browser tab, HTML result viewer                                                                                                         |
| UI stack        | **shadcn removed**; `@notyet.im/ui` + `--ny-*` tokens, matching the prototype                                                                                                              |
| First UI pass   | Channel View + Agent Detail                                                                                                                                                                |
| CLIs            | Claude Code, Codex, Antigravity, + generic BYO adapter contract                                                                                                                            |
| Migration       | **Nuke everything, fresh DB**, re-seed admin                                                                                                                                               |
| Agent defs      | `agent_blueprints` (reusable definition) + `agents` (named instance)                                                                                                                       |
| Also in scope   | Per-agent daily budget cap (pauses on hit); scheduled/triggered agents                                                                                                                     |
| From the design | Channel-level auto-approve toggle; channel repo/branch; workspace egress-rule table; resizable split view on Agent Detail                                                                  |
| Deferred        | Git/PR handoff between agents; hibernation; multi-tenancy; **SAML SSO** (on the login mockup, but it's a Better Auth plugin and independent of the harness — ship password + GitHub first) |

---

## The design (7 screens, hi-fi, light + dark)

Delivered as a Design Compiler prototype: `Channel View`, `Agent Detail`, `Dispatch Card`, `Create Agent`,
`Create Blueprint`, `Settings`, `Login`. It is more complete than the brief asked for, and it settles the
transcript hierarchy that was the hard open question.

### Design system: shadcn is removed, NotYet UI adopted (decided)

The prototype is built on **NotYet UI**, and the decision is to go with it wholesale rather than port the design
onto shadcn.

- Add `@notyet.im/ui` (React, MIT, zero runtime deps beyond React). Import `@notyet.im/ui/styles.css` and
  `@notyet.im/ui/fonts.css`; wrap the app in `<ThemeProvider theme={theme}>` and read it back with `useTheme()`.
  ~140 `--ny-*` semantic tokens, 49 components, container-query based responsiveness. Ships one ~8.5 kB gzipped
  stylesheet, so it replaces rather than layers on the current Tailwind component styling.
- **Delete `src/components/ui/` entirely** (25 shadcn primitives) and drop the shadcn tooling: `components.json`,
  the Base UI deps, and the `cn()`-plus-`tailwind-merge` chain if nothing else needs it. `src/lib/utils.ts` is
  currently shadcn-managed and only holds `cn()` — re-evaluate rather than preserve it.
- **Rewrite `CLAUDE.md`'s UI rules.** Three sections currently mandate the opposite of this decision: the
  shadcn/base-ui stack line, "Do Not Modify (shadcn/ui managed files)", and the whole "shadcn/ui Usage Rules"
  block including the Base UI `Select`-needs-`items` note. Leaving them would actively mislead the next agent
  working here — update them in the same change that removes the directory, not in Phase 8.

**Migration sizing:** 21 files import `@/components/ui` today, but 12 are pages the rewrite deletes anyway
(`dashboard`, `session`, `templates/*`, `settings/*`). The genuine migration is 7 files —
`ide-viewer.tsx`, `browser-viewer.tsx`, `result-viewer.tsx`, `language-switcher.tsx`, `app-layout.tsx`,
`main.tsx`, `login.tsx` — and the heaviest usages are `button` (17), `input` (9), `field`/`card`/`badge` (7 each),
all of which have direct NotYet equivalents. `browser-viewer.tsx`'s codec internals don't touch the UI layer, so
its migration is limited to chrome.

**Check before committing to it:** the prototype uses `SegmentedControl` (composer delivery mode) and `Switch`
(auto-approve), and Agent Detail needs a resizable split — confirm NotYet ships all three, since today's
`resizable.tsx` disappears with shadcn. If any are missing they become project components, which is fine, but
better known now than mid-build.

### What the design decides (adopt as-is)

- **Process state and activity are separate signals.** A colored dot on the avatar for the container
  (running / stopped / error) and a _pill_ for activity (idle / busy). The design note is explicit about why:
  "they fail independently — a running agent can be idle." This confirms the `agents.status` +
  `agents.activity` split already in the schema.
- **Agent activity turns are collapsed by default** into one summary row —
  `SC · @scout worked · 8 tool calls · 31s · 9.4k tokens · ●done` — expanding to a monospace list of tool calls
  rendered as `glyph · verb · target · meta` (`◇ Read src/db/schema.ts 340 ln`, `▶ Ran rg --files 0.4s`).
  Prose replies are full-width rich text with markdown, lists, and syntax-highlighted code. That is the
  signal/noise hierarchy the brief asked for.
- **Queued messages stay in the transcript**, in place, under a dashed chip: _"Queued · @backend is busy
  (running tests) · delivers when idle · cancel"_. No separate outbox.
- **Interrupt reads as heavier than Queue.** A `SegmentedControl` plus a live hint that restyles to the danger
  tone: "Stops the agent mid-task and runs this now" vs "Delivers when the agent is idle".
- **The dispatch card uses the warning surface** with a pulsing icon, an expiry countdown, and
  Approve / Edit & approve / Deny. Resolved states collapse to a quiet one-liner so history stays skimmable.
- **Artifacts are inline cards** with a mini preview that expands in place (150px → 300px).
- **`@mention` autocomplete shows live status** — handle, activity pill, and status line — so you can see an
  agent is busy _before_ sending.

### What the design adds (not previously in scope)

1. **Channel-level auto-approve ("yolo") toggle.** A `Switch` in the channel overflow menu that skips the
   approval hold entirely for that channel, with a persistent `auto-approve on` badge in the header and the
   dispatch card recoloured to the info tone reading "Auto-approved · dispatched with no hold". Sensible, and
   it's the escape hatch that makes human-gating tolerable in a high-trust room — but it is a new field and a
   new safety surface.
2. **Channels carry a repo and branch.** The header reads `Payments refactor · acme/storefront @ main` and the
   menu offers "Edit channel & repo". Earlier we put repo binding on the agent, not the channel. Treating the
   channel repo as project context that pre-fills agents created into it, with the agent's own repo still
   authoritative for its checkout.
3. **Per-agent daily budget cap** — "Agent pauses when it hits the cap." Needs a daily window and a `paused`
   state, not just a lifetime counter.
4. **SAML SSO** on the login screen alongside password and GitHub. Better Auth has an SSO plugin; this is new
   scope and is called out as deferrable below.
5. **Agent Detail is a resizable split view** — Terminal on the left, a second pane (IDE / Browser / Artifacts)
   on the right, with a draggable divider and a single-pane fallback. Richer than the plain tab strip planned.
6. **Workspace-level egress allowlist** as a table of `host · scope · added by`, rather than only a per-blueprint
   list.
7. **Members and invites** in Settings, with roles.

## Landmines in the current code (found during design — fix before building on them)

These are not hypothetical; each one silently breaks a core requirement.

1. **`agent/entrypoint.sh:121` ends with `exec /bin/bash`.** After the agent CLI exits, the PTY is a _shell_ —
   so an injected prompt becomes a shell command. Fix: `exec "$AGENT_COMMAND"` so container-exit means
   agent-exit, with the bash fallback behind a `BLACKHOUSE_DEBUG_SHELL` flag. The dispatcher must also refuse
   to inject unless the sidecar has confirmed the agent process is alive.
2. **`server/db/seed.ts:118` mounts `claude-config` → `/home/workspace/.claude` as one volume shared by every
   session.** The Claude Code sidecar reads `~/.claude/projects/**`, so every agent would see every other
   agent's transcript. A per-agent state volume is mandatory, not a nicety. (`claude-auth` stays shared — it
   holds credentials and `entrypoint.sh:5-12` symlinks `~/.claude.json` out of it.)
3. **`server/db/migrate.ts` swallows migration errors** (`console.warn` + continue). Combined with a
   destructive schema cutover that is the worst failure mode in this plan: a half-applied migration leaves a
   booting-but-broken app. Make it throw, with leniency behind `BLACKHOUSE_MIGRATE_LENIENT=1`.
4. **One stdin, many writers.** `container.attach()` yields exactly one stdin, and both browser peers and the
   injector write to it. Interleaving a multi-KB paste with human keystrokes corrupts both. Needs a per-agent
   async mutex, with peer input _buffered_ (not dropped) during injection.
5. **`server/lib/pagination.ts` is offset-based.** A live transcript that appends while you scroll will
   double-render rows. Must be keyset (`before=<createdAt>,<id>`).
6. **`HostConfig.ExtraHosts: ["host.docker.internal:host-gateway"]`** is set unconditionally at
   `sessions.ts:470`. That is a direct route to the host and defeats egress control — drop it whenever
   `egress_mode !== 'open'`.
7. **`tests/unit/mcp-protocol.test.ts` tests a `result-server.ts` that does not exist in the tree.** Dead test; delete.
8. _(Resolved by the NotYet UI decision — `src/components/ui/` is deleted rather than extended.)_

## What exists today (verified, reuse these)

- `src/db/schema.ts` — the real schema (`server/db/schema.ts` only re-exports it).
- `server/api/sessions.ts:435` — the **single** `docker.createContainer({Tty:true, OpenStdin:true, ...})` call.
  All container creation funnels through here, which makes the sandbox abstraction a contained change.
- `server/ws/terminal.ts` — binary WS protocol (`0x00` data, `0x01` resize `cols:rows`), 256KB scrollback
  ring buffer replayed to new peers, multi-peer broadcast, dockerode attach-metadata stripping.
  **`container.attach({stream,stdin,stdout,stderr,hijack,Tty})` already gives us a writable stdin — this is
  the injection path.**
- `server/lib/docker.ts` — `getDockerClient()`, `getContainerEndpoint()` + cache, TLS/socket from `docker_configs`.
- `server/proxy/ide.ts`, `server/ws/browser.ts`, `agent/browser-service/` — IDE and browser tabs, keep.
- `server/lib/{session-token-auth,messaging-rate-limit,inbox-events,pagination,validation,ws-binary}.ts` —
  port the _mechanisms_ (bearer-token auth, rate limiting, SSE fan-out, request_id dedup) onto the new model.
- `tests/fixtures/mock-agent.sh` — credential-free agent stand-in; extend it rather than inventing a new one.
- `compose.yml` — pins the Docker network name to `blackhouse`; the egress work builds on this.

---

## Phase 0 — Groundwork (zero behaviour change, app stays fully functional)

Land the pieces that nothing consumes yet, so later phases are additive rather than big-bang:

- Fix `server/db/migrate.ts` to throw (landmine 3).
- Extract `server/lib/image-build.ts` out of `server/api/settings.ts` — the egress-proxy and mock-agent images
  both need it.
- Land the whole `server/sandbox/` tree + unit tests + boot-time detection + `GET /api/settings/runtimes`.
- Extract `server/agents/pty-hub.ts` out of `server/ws/terminal.ts` behind a `resolveContainer(targetId)`
  callback, so it serves `coding_sessions` today and `agents` tomorrow. Add `write()`, `onData()`,
  `lastOutputAt()`, and the write mutex (landmine 4).
- Land `server/agents/injector.ts` + its byte-sequence tests (pure function, no Docker).
- Switch `server/lib/pagination.ts` to keyset (landmine 5).

## Phase 1 — Schema and migrations

Rewrite `src/db/schema.ts`. Keep the four Better Auth tables verbatim. Replace everything else.
Delete `drizzle/0000..0005*` and regenerate a single baseline migration (`npm run db:generate`); migrations
auto-run on boot, so ship a `drizzle/0000_*.sql` that drops the legacy app tables before creating the new ones.

**Dies:** `coding_sessions`, `session_messages`, `templates`, `agent_configs`, `session_status` enum.
**Kept:** `user`, `session`, `account`, `verification`, `docker_configs`.

New tables:

- **`agent_blueprints`** — reusable definition: `cli` (`claude-code`|`codex`|`antigravity`|`custom` — this is
  the sidecar adapter key), `agent_command`, `image`, `dockerfile_content`, `image_build_status/log/last_built_at`
  (carried over from `agent_configs`), `system_prompt`, `skills`, `mcp_config`, `volume_mounts`,
  `sandbox_runtime` (`auto`|`runc`|`runsc`|`kata`), `egress_policy`, `egress_allowlist`, `memory_bytes`,
  `nano_cpus`, `pids_limit`, `is_public`, `created_by`.
- **`agents`** — `handle` (unique on `lower(handle)`, this is the `@name`), `display_name`, `blueprint_id`,
  `owner_id`, `status` (`creating`|`running`|`stopped`|`error`|`destroyed`), `activity`
  (`idle`|`busy`|`unknown`) + `activity_updated_at` (maintained by the sidecar — this gates queued injection),
  `container_id`, `container_image`, `runtime_used` (what actually got selected after fallback), `agent_token`
  (bearer for sidecar + skill scripts), `workspace_volume`, `git_repo_url`, `git_branch`, `status_line`
  (replaces `agent_title`), `system_prompt_override`.
  Budget, per the design's "Agent pauses when it hits the cap": `daily_budget_cents`,
  `spent_cents_today` + `budget_window_start` (rolled forward lazily on read rather than by a cron), and
  `paused_at` — a paused agent keeps its container and TUI but refuses new runs, which is distinct from
  `status='stopped'`. Lifetime `tokens_in/out` for reporting.
- **`channels`** — `slug` (unique), `name`, `topic`, `is_private`, `is_archived`, `created_by`, plus from the
  design: `git_repo_url` + `git_branch` (project context shown in the header; pre-fills agents created into the
  channel, but the agent's own repo stays authoritative for its checkout) and
  **`auto_approve_dispatch` boolean default false** — the "yolo" switch. Every flip should write a
  `kind='system'` message into the channel; silently disabling the approval gate is exactly the kind of change
  that needs to be visible in history.
  No scratch volume: Docker fixes mounts at container-create time, so a per-channel volume would force a
  container recreate — and a restart killing the live TUI — every time an agent joins a channel. That directly
  fights the persistent-agent model. Agents exchange work through channel artifacts and git instead, which has
  the side benefit of keeping every handoff visible to humans rather than happening on a filesystem nobody
  watches.
- **`channel_members`** — `channel_id` + exactly one of `agent_id` / `user_id` (CHECK constraint), `role`,
  `last_read_at` (humans), `cursor_seq` (agents — replaces the old ack rows).
- **`messages`** — `seq` (bigserial, monotonic ordering), `channel_id`, `parent_id` (threading), `author_kind`
  (`user`|`agent`|`system`), `author_user_id` / `author_agent_id`, `kind`
  (`text`|`event`|`artifact`|`dispatch_request`|`system`), `body`, `mentions` (jsonb agent-id array),
  `metadata` (jsonb — tool name for events, HTML ref for artifacts), `request_id` (dedup for agent-authored
  posts, port the 60s-window logic from the old inbox), `run_id`.
  Indexes: `(channel_id, seq)`, `(channel_id, created_at)`, GIN on `mentions`.
- **`runs`** — one mention → one run: `agent_id`, `channel_id`, `trigger_message_id`, requester
  (user or agent), `prompt`, `injection_mode` (`queue`|`interrupt`), `status`
  (`queued`|`injecting`|`running`|`done`|`failed`|`cancelled`), timestamps, `tokens_in/out`, `cost_cents`, `error`.
- **`dispatch_requests`** — agent→agent gate: `channel_id`, `from_agent_id`, `to_agent_id`, `prompt`,
  `approved_prompt` (edit-before-approve), `status` (`pending`|`approved`|`denied`|`expired`), `decided_by`,
  `decided_at`, `expires_at`, `message_id` (the card), `created_run_id`.
- **`agent_events`** — raw sidecar stream, source of truth for the transcript: `agent_id`, `run_id`,
  `seq` (sidecar-assigned), `type` (`turn_start`|`assistant_text`|`tool_use`|`tool_result`|`turn_end`|`status`|`usage`),
  `payload` jsonb. `UNIQUE (agent_id, seq)` makes ingest idempotent.
- **`schedules`** — `agent_id`, `channel_id`, `cron`, `prompt`, `enabled`, `next_run_at`, `last_run_at`.
- **`egress_rules`** — from the Settings screen's `host · scope · added by` table: `host`, `scope`
  (`workspace` | `blueprint:<id>` | `agent:<id>`), `added_by_user_id`, `created_at`. The effective allowlist for
  an agent is the union of workspace rules and rules scoped to its blueprint or itself. Keeps the per-blueprint
  jsonb list as a convenience default at creation time, but this table is authoritative at connect time.

Update `scripts/seed.ts` / `server/db/seed.ts`: admin user, a `#general` channel, and one blueprint per
shipped Dockerfile.

**Gate:** `npm test` green on a rewritten `tests/unit/schema.test.ts`; server boots and migrates from empty.

---

### Detail: sandbox abstraction (built in Phase 0)

New directory `server/sandbox/`:

- `types.ts` — `SandboxSpec` (image, env, labels, mounts, exposed ports, resources, network mode, tty/stdin)
  and `SandboxDriver` (`id`, `isAvailable()`, `create`, `start`, `stop`, `destroy`, `attachPty`, `resize`,
  `exec`, `inspect`, `endpoint`).
- `docker-base.ts` — the shared dockerode implementation; lift the body of `server/api/sessions.ts:435-480`
  here more or less intact (labels, `ExposedPorts` 9223/8443, the `BLACKHOUSE_NETWORK` vs `PortBindings`
  branch — that comment block is load-bearing, keep it).
- `hardening.ts` — `CapDrop: ['ALL']` + a minimal `CapAdd` (`CHOWN`, `SETUID`, `SETGID`, `DAC_OVERRIDE`,
  `FOWNER` — agents run package managers), `SecurityOpt: ['no-new-privileges']`, `PidsLimit`, resource caps.
  **Do not set `ReadonlyRootfs`** — agents `npm install` constantly; document why.
- `runc.ts` — base + full hardening. The fallback everywhere.
- `runsc.ts` — base + `HostConfig.Runtime = 'runsc'`. The only meaningful delta; gVisor supplies the syscall
  boundary, so seccomp can stay at Docker's default rather than a custom profile.
- `kata.ts` — availability detection + a documented `NotImplementedError`. Its purpose is to prove the
  interface generalises to a VM boundary; note the `/dev/kvm` requirement.
- `registry.ts` — boot-time detection (`docker info` → `Runtimes` map + `DefaultRuntime`), cached to
  `docker_configs.detected_runtimes`, and `auto` resolution (`runsc` if present, else `runc`).

**Two functions must be pure, because no Docker daemon exists in CI or this dev container** — they are how the
whole sandbox layer gets tested:

- `toCreateOptions(spec, driverDefaults): Docker.ContainerCreateOptions` in `docker-base.ts` — absorbs
  `sessions.ts:435-478` wholesale, including the `BLACKHOUSE_NETWORK` vs `PortBindings` branch documented at
  `server/lib/docker.ts:96-115`. Tests assert `HostConfig.Runtime === "runsc"` for runsc and absent for runc.
- `resolveDriver(requested, availability)` in `registry.ts` — tested against fixture `docker info` payloads
  for runsc-present, runsc-absent, and kata-present.

`attachPty` is exactly the `container.attach(...)` + 3× retry loop at `terminal.ts:184-202`. `endpoint()` is
`getContainerEndpoint()` with the DB lookup dropped.

**Record `sandbox_driver` (requested) and `sandbox_driver_effective` (what actually ran) separately, and badge
the difference in the UI.** `runsc` is absent on Docker Desktop and Podman, so fallback will be the common case
for many users — an invisible fallback means believing you have isolation you don't.

**The Kata stub earns its place** by documenting what a VM boundary actually changes: `Memory` becomes VM RAM
(no overcommit), binds traverse virtio-fs (different `mtime` semantics — this matters for the sidecar's file
tailing), `host-gateway` is meaningless, and caps/pids are enforced in the guest. Crucially, `attachPty` /
`resizePty` / `exec` need **zero** per-driver code because they sit at the Docker API level, above the runtime.
That is the observation that says the interface will hold.

Rewire `server/api/sessions.ts`'s creation path (soon `server/api/agents.ts`) to build a `SandboxSpec` and
call the selected driver. `server/lib/docker.ts` stays as the connection/endpoint layer underneath.

Expose detected runtimes at `GET /api/settings/runtimes` so the UI can show what the host supports.

**Risk to flag in the code:** gVisor and the embedded browser. `agent/browser-service/service.mjs` drives
Chromium, which needs `--no-sandbox` under `runsc` and runs noticeably slower. Verify on a real Linux host
before making `runsc` the default for browser-enabled blueprints.

**Gate:** unit tests over spec-building and driver selection using the mocked-dockerode pattern already in
`tests/unit/docker-client.test.ts` (no Docker daemon is available in CI or this dev container).

---

### Detail: server-owned PTY and injection (built in Phase 0)

Refactor `server/ws/terminal.ts`: today a terminal session is created lazily by the first WS peer. Move
ownership to a server-side `server/lib/pty.ts` that holds the attach stream per agent for the container's
lifetime; WS peers become subscribers. Scrollback, multi-peer broadcast, and the attach-metadata grace
window move with it unchanged.

Add `injectPrompt(agentId, text, mode)`:

- Multi-line prompts are wrapped in **bracketed paste** (`\x1b[200~` … `\x1b[201~`) then `\r`, so TUIs
  receive them as one paste rather than a line-per-newline submit.
- `interrupt` mode writes `\x1b` (ESC), waits ~200ms, then pastes.
- `queue` mode checks `agents.activity`; if `busy`, the run is parked at `status='queued'` and a drainer
  releases it when the sidecar next reports idle.

Both writers (browser peers and the injector) serialize through a per-agent async mutex; peer keystrokes are
buffered during an injection and flushed after, and peers get a `0x02` system frame so the UI can show an
"injecting…" banner. **The protocol already reserves `0x02`** — `src/components/terminal.tsx:106` ignores it today.

**Gate:** unit tests asserting the exact byte sequences for both modes and the queue state machine.
A manual `POST /api/agents/:id/inject` makes this demoable before channels exist.

---

## Phase 2 — Agent cutover (old UI dies, new UI thin)

Ship `server/api/agents.ts` + `server/agents/{lifecycle,volumes,reconcile}.ts` on top of `SandboxDriver`
(egress stays `open` at this stage). Delete `sessions.ts`, `templates.ts`, `result.ts`, `lib/session*.ts`.
Re-home `terminal.ts`, `ws/browser.ts`, `proxy/ide.ts` onto `:agentId`.

`server/agents/reconcile.ts` runs at startup: list containers labelled `blackhouse.managed=true`, re-link by a
`blackhouse.agent_id` label, mark vanished containers as `stopped`. This replaces the inline auto-detect block
at `sessions.ts:254-274`, which currently runs a `container.inspect()` on _every_ session read.

**Sequencing note:** `server/api/sessions.ts` is chained into `AppType` and consumed by `hc<AppType>` in
`src/lib/api.ts`, so deleting it breaks every client call site simultaneously. Plan this as one large mechanical
commit driven by `npx tsc --noEmit`, not as an incremental refactor.

**Test the browser service under gVisor here**, not in Phase 6. Chromium + ffmpeg + Playwright is the workload
most likely to misbehave under `runsc`, and Phase 2 is while backing out is still cheap.

✅ _End state: create an agent, it starts under runsc-or-runc, attach to its TUI, use the IDE and browser tabs._

---

## Phase 3 — Channels, messages, and the Slack-like UI

Server — replace `sessions.ts` / `templates.ts` with:

- `server/api/agents.ts` — CRUD, start/stop/destroy, inject, status.
- `server/api/blueprints.ts` — CRUD + image build (carry over the build logic from the old settings routes).
- `server/api/channels.ts` — CRUD, membership, keyset-paginated message list, post.
- `server/api/stream.ts` — **one** SSE connection per tab, multiplexed by topic
  (`GET /api/stream?channels=a,b`). Reuse the 15s heartbeat and `c.req.raw.signal` abort cleanup from
  `server/lib/inbox-events.ts` — they're correct. One SSE per channel per tab does not scale and retrofitting
  the multiplex later is worse than building it now.
- `server/api/runs.ts` — status, cancel.

Mention parsing lives in `server/lib/mentions.ts`: resolve `@handle` → agent id, write `messages.mentions`,
create a `run` per mentioned agent, then hand off to `injectPrompt`. Rate-limit posts by generalizing
`server/lib/messaging-rate-limit.ts` into a keyed token bucket (the algorithm is fine, only the key changes).

**Queue mode is real before the sidecar exists.** Idle gating in this phase uses PTY quiescence alone, which
the hub gives us for free via `lastOutputAt()`. Phase 4 upgrades it; it does not unblock it.

Client — decomposition follows the prototype's `Channel View`:

```
src/pages/channel.tsx              three-pane: sidebar | transcript+composer | (optional right rail)
src/components/channel/
  channel-sidebar.tsx              workspace switcher, channel list w/ unread pill + mention dot, agent
                                   roster (avatar + process dot + activity pill + status line), current user
  channel-header.tsx               #slug, member counts, topic · repo @ branch, auto-approve badge,
                                   overflow menu (auto-approve Switch, edit channel & repo, leave)
  transcript.tsx                   keyset scroller, day dividers
  message-human.tsx                avatar, name, time, body with @mention chips
  message-agent-text.tsx           agent avatar + `agent` badge, markdown/lists/code
  message-turn.tsx                 collapsed summary row → expandable tool-call list
  tool-call-row.tsx                glyph · verb · target · meta
  artifact-card.tsx                header + inline preview, expands 150→300px
  dispatch-card.tsx                pending / approved / denied / auto-approved
  queued-chip.tsx                  dashed "Queued · @x is busy (…) · delivers when idle · cancel"
  composer.tsx                     textarea + SegmentedControl mode + live danger-toned hint + send
  mention-autocomplete.tsx         popover listing agents with live activity + status line
src/pages/agent.tsx                top bar, agent header, tab bar, split-view toggle
src/components/agent/
  split-pane.tsx                   draggable divider, leftPct state, single-pane fallback
  agent-header.tsx                 handle, blueprint, runtime badge, egress badge, budget meter, stop confirm
src/pages/{agents,create-agent,create-blueprint,settings/*,login}.tsx
```

`terminal.tsx`, `ide-viewer.tsx`, `browser-viewer.tsx`, `result-viewer.tsx` are **retargeted, not rewritten** —
the diff is `sessionId: string` → `agentId: string` plus a status prop. Do not touch the ~978 lines of H.264
codec work in `browser-viewer.tsx`.

Retire `dashboard.tsx`, `session.tsx`, `session-worker-card.tsx`, `templates/*`, and the `inbox-events`
context/hook.

All of the above are built on `@notyet.im/ui` primitives against `--ny-*` tokens — no shadcn, no `cn()`.
The mention autocomplete is a positioned listbox rather than a `Select`: a form control cannot back an inline
text trigger.

**The `mention_autocomplete` trigger regex from the prototype is `/(^|\s)@[\w-]*$/`** — reuse it verbatim so
client-side triggering and server-side parsing agree on what a handle looks like.

**The tool-call display shape is a schema requirement, not a rendering detail.** The sidecar's `tool_call`
payload must carry `glyph`/`verb`/`target`/`meta` (or enough to derive them) so the transcript can render
`◇ Read src/db/schema.ts 340 ln` without the client re-parsing raw tool input. Likewise the turn summary needs
`tool_call_count`, duration, and token usage on `runs` — all already planned.

**Gate:** `@mention` in the UI visibly types into the agent's TUI when you open the Terminal tab.

---

## Phase 4 — Sidecar and transcript (completes the vertical slice)

Two ingest paths, one event schema, one endpoint:
`POST /api/agents/:id/events` (bearer `agent_token`), idempotent on `(agent_id, seq)`.

- **In-container sidecar** — `agent/sidecar/` (Node builtins + global `fetch`, zero deps), started from
  `agent/entrypoint.sh` exactly like `browser-service` and `code-server` are today, replacing the
  `/tmp/.blackhouse-hint` inbox-watcher poll loop. `adapters/claude-code.mjs` tails
  `~/.claude/projects/**/*.jsonl` and maps entries to events, including `usage` for the budget counters.
  - **Poll at ~500ms; do not use `fs.watch`.** inotify over overlayfs and named-volume mounts silently misses
    events. Track `{path → byteOffset}`, read deltas, hold the partial trailing line.
  - **Idempotency key is `(agent_id, source_ref)` with a unique index and `ON CONFLICT DO NOTHING`.** Claude
    Code stamps a `uuid` per JSONL line — use it, falling back to `sha1(path + offset)`. Retries, container
    restarts, and offset rewinds all collapse harmlessly.
  - **Defensive by contract**: an unknown entry type emits a `raw` event carrying the whole object. The adapter
    must never throw, never block the tail loop, and never drop its watermark on a parse error. This JSONL
    format is undocumented and version-coupled; it has to degrade to "coarse but alive".
  - **Never post full tool inputs** — a single tool call can carry an entire file. Send a digest + 2KB preview,
    and truncate server-side too.
  - **Ship a fetch-on-boot override**: `entrypoint.sh` pulls `$BLACKHOUSE_URL/.well-known/blackhouse/sidecar.tar`
    and prefers it over the baked-in copy. Otherwise every sidecar tweak means rebuilding three ~3GB images,
    and during a rewrite that iteration cost dominates. Same trick the skills install already uses.
  - **Requires the per-agent state volume** from landmine 2 — with today's shared `claude-config` volume this
    adapter reads every agent's transcript.
- **Server-side PTY-scrape** — the degraded adapter for Codex/Antigravity/BYO. This runs on the **server**,
  not in the container: `server/lib/pty.ts` already has every byte of terminal output, so
  `server/sidecar/pty-scrape.ts` strips ANSI and emits coarse `turn_start` / `assistant_text` / `turn_end`
  events. No in-container work needed for these CLIs.
- **Idle/busy — belt and braces**, because either signal alone is wrong sometimes:
  `idle ⟺ (JSONL quiet > ~1500ms) ∧ (last event ∈ {assistant_text, run_end}) ∧ (PTY quiet > ~750ms)`.
  The first two clauses are computed in-container and POSTed as a `state` event; the third is computed
  server-side by the hub (which already timestamps every chunk for the scrollback ring). The dispatcher ANDs
  them. PTY-scrape adapters only have the third clause — coarse, and that is the documented degradation.
  Heartbeat `state` at ≤10s; 30s of silence sets `activity='unknown'`.
  Timing constants live in a **per-adapter profile**, not as global constants — tune empirically.
- **BYO contract** — `agent/sidecar/adapters/CONTRACT.md`: implement `start(ctx)` emitting the event union,
  or emit nothing and inherit server-side PTY-scrape for free.

Rewrite `agent/skills/blackhouse/`: drop `send-msg.sh`, `check-inbox.sh`, `list-sessions.sh`. Add `post.sh`
(post to a channel), `mention.sh` (request a dispatch — creates a pending card, does **not** dispatch), and
`read.sh` (read a channel from the agent's `cursor_seq`). Keep `browser.sh` / `browser-shim.sh`;
`submit-result.sh` becomes an artifact post and `update-title.sh` writes `agents.status_line`.
Bash scripts stay the universal contract across CLIs; an MCP server for Claude Code is a later enhancement.
Update `SKILL.md` and keep serving it from `server/api/skills.ts`.

**Gate — this is the slice:** create agent → container starts via a sandbox driver → `@mention` in a channel →
prompt lands in the live TUI → sidecar events render as a transcript in the channel → Terminal tab shows it live.

---

## Phase 5 — Human-gated agent→agent dispatch

`mention.sh` from an agent creates a `dispatch_requests` row and a `kind='dispatch_request'` message.
`dispatch-card.tsx` renders caller → callee, the proposed prompt, and Approve / Edit & approve / Deny with a
live expiry countdown; resolved states collapse to a one-liner. `server/api/dispatch.ts` owns the state machine
and a sweeper expires stale cards.

When the channel has `auto_approve_dispatch` on, the dispatch skips `pending_approval` and goes straight to
`queued`, and the card renders in the info tone as an after-the-fact record ("Auto-approved · dispatched with no
hold · override in channel settings"). The card is still written to the transcript — auto-approve removes the
_hold_, not the _record_. Budget checks and loop guards still apply; auto-approve is not a bypass of those.

## Phase 6 — Egress policy

Two networks: `blackhouse-internal` (`internal: true` — no route out) for agents, and the existing
`blackhouse` bridge, with the app joined to both. Because the internal network has no gateway, _all_ agent
egress must traverse the harness proxy — that is the enforcement, not the allowlist itself.

`agent/egress-proxy/proxy.mjs` — a ~200-line CONNECT proxy on raw `node:http` + `node:net`, zero deps, built
as `blackhouse-egress:latest`. Consistent with `agent/browser-service`, no third-party image, and the allowlist
matcher is a pure function we can unit-test (exact / `.suffix` wildcard / port / IP-literal / punycode / case).
Agents authenticate with `Proxy-Authorization: Basic <agent_id>:<agent_token>` — per-agent credentials, not
source-IP matching, which is brittle across restarts. Policy is refetched every 30s so edits apply live.
Containers get `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` in `SandboxSpec.env`.

**No CA is needed in v1** — a CONNECT-level domain allowlist never terminates TLS, so there is nothing to sign.
Shipping a trust root means installing it into every image _and_ into node/npm/pip/git/curl individually: a
large brittle surface for zero v1 benefit. Leave a documented hook for TLS interception if body-level auditing
is ever needed.

Key the proxy by `sha1(sorted allowlist)` so agents with identical policy share one proxy + network rather than
one each. `open` additionally attaches the bridge network; `none` grants no proxy credentials.
Drop `ExtraHosts: host-gateway` whenever the mode isn't `open` (landmine 6). Update `compose.yml`.

**Verify empirically before designing this phase in detail:** in container-network mode the harness reaches
agents over `BLACKHOUSE_NETWORK`, a normal bridge _with_ internet access — so `none`/`allowlist` would be a lie
unless that network is itself internal and the app is dual-homed. And in host-mode dev it is not obvious that
port publishing works at all on an `internal: true` network. Ship `docker_configs.egress_enforce=false` as the
dev escape hatch.

## Phase 7 — Budgets and schedules

Budgets: the sidecar's `usage` events accumulate into `runs.cost_cents` → `agents.spent_cents_today`. On
crossing `daily_budget_cents` the agent is **paused** — container and TUI stay up, new runs are refused, a
system message lands in the channel, and the roster shows a paused state. Enforce in `server/lib/mentions.ts`
before a run is created, and roll the daily window lazily on read.

Remaining design screens land here: `Create Agent` (two-step wizard), `Create Blueprint`, `Settings`
(blueprints / runtimes / egress / members + invites).

Schedules: `server/lib/scheduler.ts` — a single in-process interval that polls `schedules.next_run_at` and
creates runs. Deliberately not a distributed job queue; this is a single-instance harness.

## Phase 8 — Docs and cleanup

`readOnlyRootfs` and custom seccomp behind per-agent opt-in flags. Kata stub documentation. Egress-log
retention reaper. Rewrite `CLAUDE.md` (already stale — it predates the browser tab, IDE proxy, i18n, and the
messaging layer) and `README.md`. Document the sandbox runtime matrix, how to install gVisor on the VPS, the
BYO adapter contract, and the egress policy model. Delete dead files and stale screenshots.

---

## Testing

Survives: `utils`, `codename`, `drizzle-journal`, `auth-helpers`, all four browser-codec/RPC tests,
`mcp-protocol`, `docker-client` (extended). Rewritten: `schema`, `session-status` → `agent-status`.
Deleted: `inbox-events`, `messaging-rate-limit` (rewritten against channels).

New unit tests: sandbox spec-building per driver, hardening flags, runtime detection + `auto` fallback,
injection byte sequences (bracketed paste, ESC-then-paste), queue-until-idle state machine, Claude Code
JSONL → event mapping, PTY-scrape ANSI stripping and idle detection, mention parsing, dispatch approval
state machine, egress allowlist matching, budget enforcement.

New e2e (`tests/e2e/`): rewrite `dashboard`/`session`/`templates` specs into `channel`, `agent`, `dispatch`.
**The highest-leverage item in the whole test plan**: evolve `tests/fixtures/mock-agent.sh` into a fake TUI
(`mock-agent-tui.sh`) that (a) reads stdin lines and echoes `> <line>` — proving injection landed on the PTY,
(b) appends synthetic entries to `$CLAUDE_CONFIG_DIR/projects/mock/<uuid>.jsonl` — proving the JSONL adapter
and projection work, and (c) sleeps N seconds per "turn" — exercising busy→idle gating. Pair it with
`agent/dockerfiles/mock.Dockerfile` (node:24-slim + sidecar + curl/jq, builds in ~15s) and a `mock` blueprint
row in the seed.

With that fixture the **entire vertical slice** — create agent → sandbox start → channel post → mention →
dispatch → injection → PTY → sidecar → transcript — runs in CI with zero agent credentials and no 3GB image.
This is the same trick commit `3f9c6c7` already used, taken further.

Note `tests/e2e/helpers.ts` needs real surgery: `signInAsAdmin` anchors on the "Roster" heading, and the ~200
lines of messaging helpers die with the inbox. `execInContainer` and `getTestDockerClient` survive and are
exactly what the sandbox e2e needs.

No Docker daemon exists in CI or this dev container, so every sandbox test must mock dockerode. The gVisor
and Kata paths need manual verification on a real Linux host — call this out in the PR.

## Verification

0. UI pass: `Channel View` and `Agent Detail` render in light and dark against mock data, with all five
   transcript message kinds (human, agent text, collapsed turn, artifact, dispatch card), the queued chip, the
   queue/interrupt hint restyling to danger, the mention autocomplete showing live status, the auto-approve
   toggle flipping the card's tone, and Agent Detail's split view dragging and collapsing to single-pane.
   `npx tsc --noEmit` clean with `src/components/ui/` deleted.
1. `npm run format:check && npm test` (both are pre-commit gates per `CLAUDE.md`).
2. `docker compose -f compose.dev.yml up` → server migrates from an empty DB and seeds admin + `#general`.
3. Create a blueprint from `agent/dockerfiles/claude-code.Dockerfile`; create `@scout` from it; confirm
   `agents.runtime_used` reports `runc` locally and `runsc` on a gVisor host.
4. In `#general`, post `@scout summarise this repo`. Expect: a run appears, the prompt lands in the TUI
   (verify on the Terminal tab), and sidecar events render as a transcript in the channel.
5. While `@scout` is busy, post another mention in queue mode → shows "queued", fires on idle. Repeat with
   interrupt mode → current turn stops and the new prompt starts.
6. Have `@scout` run `mention.sh @reviewer ...` → a dispatch card appears; deny it, then approve an edited
   one and confirm `@reviewer`'s TUI receives the edited prompt.
7. With `egress_policy='allowlist'`, `curl https://example.com` inside the agent fails and
   `curl https://api.anthropic.com` succeeds; check the proxy audit log.
8. `npx playwright test`.

## Verified on a real host (Ubuntu 24.04 + Docker 29.7.2 + gVisor)

Run against a live daemon over mutual TLS. These were previously assumptions.

| Claim                                                           | Result                                                                                                                                                                                   |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| gVisor produces a real syscall boundary                         | **Confirmed.** Kernel inside a `runsc` container is `4.19.0-gvisor` with `dmesg` showing "Starting gVisor…"; under `runc` it is the host's `6.8.0-63-generic`.                           |
| Hardening is compatible with gVisor (open risk #2)              | **Confirmed.** `CapDrop:[ALL]` + minimal add-back, `no-new-privileges`, `PidsLimit 512`, 2GB memory all applied under `runsc`; container started and ran normally. No `ENOSYS` failures. |
| `auto` selects gVisor where present                             | **Confirmed.** `resolveDriver(auto) -> runsc`; `resolveDriver(kata) -> runsc` with `fellBackFrom=kata` and a stated reason.                                                              |
| An `internal: true` network has no route out (open risk #4)     | **Confirmed.** No default route — only the link-local subnet.                                                                                                                            |
| Docker's embedded DNS does not forward from an internal network | **Confirmed.** `SERVFAIL` for external names. This was flagged as a possible residual exfiltration channel; it is closed.                                                                |
| Egress cannot be bypassed with a literal IP                     | **Confirmed.** Both hostname and raw-IP fetches blocked.                                                                                                                                 |

### Verification steps 2–7: all pass

Run end to end against the live daemon, from an empty database each time, with the mock agent under
`runsc`. Four rounds were needed — each of the first three ended in a real bug, listed below.

| Step                             | Result                                                                                                                                                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2 · migrate + seed from empty    | **Pass.** 17 tables created, admin login 200, `#general` and three blueprints seeded.                                                                                                                                               |
| 3 · agent starts, runtime honest | **Pass.** `requested=auto, runtimeUsed=runsc`, and `uname -r` inside the container is `4.19.0-gvisor` — the badge reflects what actually ran.                                                                                       |
| 4 · mention → TUI → transcript   | **Pass.** The whole slice. Prompt reaches the PTY, sidecar posts 8 events, transcript shows prose plus tool calls in the designed shape: `◇ Read /workspace/README.md · 120 ln`.                                                    |
| 5 · queue vs interrupt           | **Pass.** Busy agent → `queued: "@scout is busy — delivers when idle"`, released to `running` once idle. Interrupt never queues.                                                                                                    |
| 6 · human-gated dispatch         | **Pass.** Agent mention creates a pending card, does not dispatch; deny records `denied`; edit-and-approve keeps the original beside the edit, and only the **edited** text reaches `@reviewer`'s TUI (`EDITED` ×2, `ORIGINAL` ×0). |
| 7 · per-agent egress allowlist   | **Pass, with enforcement explicitly enabled** — see below.                                                                                                                                                                          |

Step 7 needs its caveat stated plainly. `docker_configs.egress_enforce` **ships false**, so on default
settings there is no enforcement to test and the step is vacuous. Turning it on for the run gives the
result the step actually asks for, under `policy=allowlist` with `["api.anthropic.com"]`:

```
api.anthropic.com → 401     (reached Anthropic and was rejected for credentials — connectivity proven)
example.com       → blocked
raw IP 1.1.1.1    → blocked
HTTPS_PROXY       = http://<agent-id>:<token>@egress-proxy:3128
```

That last line is the one worth keeping. The allowlisted host resolved and connected **while the agent
itself had no working DNS at all** — the CONNECT proxy resolved on its behalf. It is direct evidence
for the claim in the DNS section below: the enforced path is unaffected by the gVisor resolver gap, and
`open` is the policy left exposed by it.

Still unverified: gVisor × Chromium (the browser pane), the inject→transcript path against a real agent
CLI rather than the mock TUI, and Kata (needs nested virtualisation, which ordinary cloud VMs do not
expose).

### Four bugs the live run found, none of them visible to a unit test

Each broke a core path, each was invisible to mocked dockerode, and each now has a regression test.

1. **`PtyHub not configured`** (`98a60ce`). The hub was wired lazily from the terminal WebSocket route,
   so injection only worked if somebody had already opened that agent's Terminal tab in this server
   process. Mentioning an agent without visiting its terminal first — the ordinary case — failed the run.
   Now configured at startup. The test asserts call ordering in `server/index.ts`, because the failure
   was ordering, not logic.

2. **`NetworkMode` left at `bridge`** (`7eb9cc1`). `NetworkingConfig.EndpointsConfig` attaches a
   container to a network but does not make it _primary_, and Docker only points `/etc/resolv.conf` at
   its embedded resolver for containers whose primary network is user-defined. The agent held a correct
   IP on the correct network and still could not resolve `app`.

3. **gVisor has no working DNS at all** (`c677ce9`) — the deepest of the three, and the one that most
   nearly shipped. Docker's embedded resolver at 127.0.0.11 is a loopback listener in the container's
   _host-side_ network namespace; `runsc` runs the sandbox on its own netstack
   (`dev.gvisor.flag.network: sandbox`) and never reaches it. A/B on one network, identical but for the
   runtime:

   ```
   [runc ] getent app → 172.18.0.4   ; getent example.com → 2606:4700:10::…
   [runsc] getent app → NO-RESOLVE   ; getent example.com → NO-RESOLVE
   [runsc] UDP to 127.0.0.11:53      → no reply
   ```

   So under the runtime this design _defaults to on Linux_, the sidecar could never POST to
   `http://app:3000`. Note what fixing bug 2 alone bought: resolv.conf then pointed at a resolver the
   sandbox still could not reach — the configuration became correct and the behaviour did not change.

   The fix that works is to pin the names an agent must reach into `/etc/hosts`, which needs no
   resolver: the harness, and the egress proxy (whose address agents know only as a Docker network
   alias, so an _enforced_ agent under runsc could not resolve its own proxy either). With that, step 4
   passes end to end under gVisor.

   The general lesson: **gVisor's isolation extends to the network stack**, so anything Docker
   implements by way of the host network namespace — embedded DNS here — is unavailable to a sandboxed
   container. Any future feature that reaches a container by service name needs the same treatment.

4. **Queue mode never drained** (`4abee4c`). Half the feature shipped: posting to a busy agent parked
   the run at `queued` and answered _"@scout is busy — delivers when idle"_. Nothing kept that promise —
   the agent returned to idle and the run stayed queued. The prompt is accepted, renders in the
   transcript as pending, and never runs.

   Worth noting how this one hid. The plan specifies the drainer in as many words ("a drainer releases
   it when the sidecar next reports idle"), the parking side was implemented and correct, and the
   symptom only appears if you check the run's status _after_ the agent goes idle — which the first
   version of step 5 did not do. It asserted that queue mode "reports a decision", and a race let it
   pass by measuring the immediate-delivery path instead. Tightening the check to drive the agent busy
   first, assert `queued: true`, and then wait for release is what exposed it.

   No unit test could have caught it either: the missing piece was a caller, not a behaviour. So the
   regression test asserts on the call sites, and the readiness rule was pulled out as a pure function
   — including that a run parked for _busy_ must still not fire if the agent has since been stopped or
   hit its budget cap, and that `unknown` activity is not permission.

   **Both lessons generalise: a test that accepts either outcome tests nothing, and a feature whose two
   halves live in different files can ship with one half missing and every test green.**

### Open, and a design decision rather than a bug: general DNS inside gVisor

Pinning fixes the names Blackhouse controls. It does not give a gVisor agent ordinary hostname
resolution, so `git clone https://github.com/…` and `npm install` do not work there today.

`HostConfig.Dns` looks like the fix and is not. On a user-defined network Docker keeps 127.0.0.11 in
resolv.conf and uses those servers only as its own upstreams — visible in the generated file as
`ExtServers: [1.1.1.1 8.8.8.8]` — and the stub is exactly what the sandbox cannot reach. The setting is
retained (correct field, correct on the host-network path, `BLACKHOUSE_AGENT_DNS` overrides it) but it
is inert for gVisor, and the code says so rather than implying a fix.

The sandbox is not the obstacle. Measured from inside runsc:

```
UDP query to 1.1.1.1:53   → reply, 61 bytes
https://1.1.1.1           → 301
UDP query to 127.0.0.11:53 → no reply
```

A real nameserver simply needs to reach resolv.conf. Three ways, none free:

1. **Write resolv.conf from the entrypoint.** Blocked as shipped: the agent images drop to a non-root
   user, and the file is root-owned. Would mean starting as root and dropping privileges after.
2. **Leave the user-defined network secondary** so Docker writes `Dns` verbatim. This reintroduces the
   default bridge — the route out that egress enforcement exists to remove — and it is the exact
   inverse of bug 2's fix.
3. **Resolve names at the proxy.** Under `allowlist`/`none` this is already how it works: a CONNECT
   proxy resolves on its own side, so the agent never needs DNS. It is only the `open` policy, where
   there is no proxy, that is left without resolution.

(3) means the enforced path is fine and the permissive path is the broken one, which is at least the
right way round. Picking between (1) and (2) for `open` agents is a security trade-off, so it is
recorded here rather than decided mid-verification.

### Note on the transport used to reach the host

The sandbox environment relays **only port 443** through its HTTP CONNECT proxy. It answers
`200 Connection Established` for any port and then silently drops non-443 traffic, so a `200` is not
evidence of reachability — confirmed by `imap.gmail.com:993` failing identically to a closed port while
`api.github.com:443` succeeded. The daemon therefore listens on 443, and `scripts/proxy-tunnel.mjs`
bridges a local port to it. The Docker CLI also honours `HTTPS_PROXY`, so `NO_PROXY` must include the
daemon's hostname or the CLI bypasses the tunnel and fails.

## Open risks

Ordered by how much they'll hurt.

1. **Injecting into a TUI is the riskiest thing in this plan.** Claude Code / Codex / Antigravity are Ink-based,
   own the alternate screen, and interpret stdin with their own key handling. Bracketed paste is the right bet,
   but the app must have paste mode enabled, some TUIs treat a paste as "fill composer" and need a separate
   Enter, and a fast `\r` can race the app's paste-coalescing timer. Worse: if the TUI is **not** sitting on its
   composer — e.g. it's showing a y/n permission prompt — the injection does something arbitrary, and there is
   no fully reliable way to detect that. The Claude Code adapter can see permission state in the JSONL;
   PTY-scrape cannot, so this is a real fidelity gap for the degraded CLIs.
   Mitigations: per-adapter timing profile tuned empirically; store the last 4KB of PTY output on the dispatch
   row so a human can see what actually happened; surface delivered-but-no-response as a warning after N seconds.
2. **`readOnlyRootfs` will break the agent images** in non-obvious ways — apt, pip, npm cache, code-server
   extension install. Default it `false` in v1 and expose it per-agent. Don't let "hardened defaults" become
   "nothing starts."
3. **gVisor × Chromium** — the embedded browser service (Chromium + ffmpeg + Playwright) is the workload most
   likely to misbehave under `runsc`, probably needing `--no-sandbox` and running slower. Unverifiable here
   (no Docker daemon); test in Phase 2 on a real Linux host, while backing out is still cheap.
4. **Egress enforcement vs. the harness's own reachability** — see Phase 6; needs empirical verification that
   `internal: true` networks and loopback port publishing coexist.
5. **Container-lifetime PTY ownership** — holding an attach stream open per agent for its whole life is a change
   in resource shape from today's lazy per-peer attach. Watch for leaks on container restart.
6. **Auto-approve is a real safety surface, not a convenience toggle.** It disables the only human gate on
   agent→agent dispatch for an entire channel. Loop guards (hop depth, cycle detection) and budget caps become
   the sole backstop when it is on, so they must exist _before_ the toggle ships — not after. Log every flip as
   a channel message, and keep writing dispatch cards so the history still shows what was dispatched.
7. **Bulk handoff has no filesystem path.** With shared scratch dropped, an agent that produces something large
   (a build output, a dataset) can only hand it over via git or a channel artifact. If that proves too
   constraining in practice, the fallback is a single `/scratch` volume with per-channel subdirectories —
   isolation by convention, no container recreate — rather than true per-channel volumes.
