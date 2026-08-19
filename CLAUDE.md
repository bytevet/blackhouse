# Blackhouse

A Slack-like harness for coding agents. Persistent named agents (`@scout`, `@reviewer`) live as
teammates in channels alongside humans. Mentioning an agent injects the prompt into its **live TUI** —
a real Claude Code / Codex process on a PTY inside a sandboxed container — and a sidecar streams what
the agent does back into the channel as a readable transcript.

Two ideas carry the product, and most of the non-obvious code exists to serve them:

1. **The agent is a live process, not a chat completion.** It has a terminal you can attach to, a
   filesystem, an editor, a browser, and a state (idle / busy / blocked on a prompt). The UI is built
   to make that machine feel present and inspectable rather than hidden behind a chat metaphor.
2. **Agents run untrusted, model-authored code.** Isolation is a pluggable container runtime, not an
   afterthought, and every place where isolation could silently degrade is surfaced loudly.

## Tech Stack

- **Server**: Hono (API routes, WebSocket, SSE, static serving)
- **Client**: React SPA + React Router v7
- **Database**: PostgreSQL + Drizzle ORM
- **Auth**: Better Auth (admin plugin, username plugin, GitHub OAuth)
- **UI**: `@notyet.im/ui` ("NotYet UI") + `--ny-*` design tokens
- **Sandbox**: pluggable driver over dockerode — `runc`, `runsc` (gVisor), Kata stub
- **Terminal**: xterm.js + binary WebSocket protocol
- **Build**: Vite (client) + tsx (server)
- **Testing**: Vitest (unit) + Playwright (e2e)

## Project Structure

```
server/
├── index.ts            # App entry — mounts routes, boots background jobs, probes runtimes
├── api/
│   ├── agents.ts       # Agent CRUD, lifecycle, and the raw inject endpoint
│   ├── channels.ts     # Channels, keyset transcript, message posting + mention routing
│   ├── stream.ts       # ONE multiplexed SSE connection per tab
│   ├── dispatches.ts   # Approve / deny agent→agent dispatch
│   ├── agent-runtime.ts# Called from INSIDE containers (sidecar + skill scripts)
│   ├── settings.ts     # Blueprints, image builds, docker config, users
│   └── skills.ts       # .well-known/agent-skills
├── agents/
│   ├── pty-hub.ts      # Server-owned attach stream, scrollback, write mutex
│   ├── injector.ts     # Prompt → PTY bytes (bracketed paste, interrupt)
│   ├── lifecycle.ts    # SandboxSpec construction, start/stop/destroy
│   ├── events.ts       # Sidecar event contract + transcript projection
│   ├── pty-scrape.ts   # Degraded transcript for CLIs with no structured log
│   ├── dispatch.ts     # Agent→agent approval state machine
│   └── adapters/       # Per-CLI timing and key-binding profiles
├── sandbox/            # Pluggable runtime drivers (see below)
├── egress/             # Allowlist matching + proxy management
├── ws/                 # terminal.ts, browser.ts
├── proxy/ide.ts        # code-server proxy
├── lib/                # mentions, stream-bus, scheduler, auth helpers, docker client
└── db/                 # schema re-export, migrate, seed
src/
├── layouts/app-shell.tsx  # The rail + the one SSE connection. Channels and agents render inside it
├── pages/              # channel, agent-pane, create-agent, settings/*, login
├── components/
│   ├── workspace/      # Channel list, roster, and the shared stream (`useStreamTopic`)
│   ├── channel/        # Transcript, the five message kinds, composer, mention autocomplete
│   ├── agent/          # Split pane, header, panes
│   └── terminal.tsx, browser-viewer.tsx, ide-viewer.tsx, result-viewer.tsx
├── lib/agent-status.ts # THE status→tone mapping. Do not duplicate it.
└── i18n/               # Typed keys — `t()` is checked against en.json
agent/                  # Injected into agent containers
├── dockerfiles/        # Per-CLI images + mock image for tests
├── entrypoint.sh       # Clone, start services, exec the agent CLI
├── sidecar/            # Tails the CLI's session log, POSTs events
├── egress-proxy/       # CONNECT proxy with per-agent allowlist
└── skills/blackhouse/  # Scripts the agent calls to post, mention, submit artifacts
design/                 # Hi-fi prototype the UI is built from (read-only reference)
docs/                   # Implementation plan
```

## Pre-Commit Requirements

**Before every commit, run both and ensure they pass:**

1. `npm run format:check` — Prettier
2. `npm test` — Vitest

If formatting fails, run `npm run format`, then re-stage.

## Commands

```bash
npm run dev            # Vite (5173) + Hono (3000)
npm run build          # Build client + server
npm test               # Unit tests
npm run format         # Auto-fix formatting
npm run db:generate    # Generate a migration from schema changes
npm run db:seed        # Seed admin, blueprints, #general
npx playwright test    # e2e
```

## Concepts that are easy to get wrong

These are the places where a reasonable-looking change breaks something important.

### Status and activity are two independent signals

`agents.status` is the **container** (`creating` / `running` / `stopped` / `error` / `destroyed`).
`agents.activity` is the **process inside it** (`idle` / `busy` / `unknown`). A running agent can be
idle; a busy agent whose container just died is briefly both. The roster renders them differently —
a coloured dot on the avatar for the process, a pill beside the handle for activity — and
`tests/unit/schema.test.ts` fails if anyone folds them back together. All colour mapping lives in
`src/lib/agent-status.ts`; do not re-derive it per component.

### The injected prompt is the whole product

`container.attach({tty: true, stdin: true})` yields exactly **one** stdin, and both browser peers and
the injector write to it. `pty-hub.ts` serialises them through a per-agent mutex and buffers peer
keystrokes during an injection — without that, a multi-KB paste interleaved with typing corrupts both.

`entrypoint.sh` must `exec` the agent CLI. If it drops to a shell after the CLI exits, an injected
prompt becomes a shell command.

Injection timing and key bindings are **per-CLI** (`agents/adapters/profiles.ts`). ESC-to-interrupt is
Claude Code's binding; others differ. Prompts are sent as bracketed paste, chunked, because a PTY line
discipline drops oversized single writes and a `\r` racing the TUI's paste-coalescing window submits
half a prompt.

### The sandbox fallback must stay visible

`agents.sandboxRuntime` is what was **requested**; `agents.runtimeUsed` is what actually **ran**.
gVisor is absent on Docker Desktop and Podman, so falling back to `runc` is the common case. The UI
shows the effective runtime and turns a fallback into a danger-toned banner. An invisible fallback
means someone believes they have isolation they do not have — that is the failure mode this design
exists to prevent.

No Docker daemon exists in CI or in dev containers, so **sandbox tests must be pure or mock dockerode**
(`toCreateOptions` and `resolveDriver` are pure for this reason). gVisor and Kata need manual
verification on a real Linux host.

### Transcript hierarchy

An agent turn emits dozens of tool calls. Prose is the conversation; tool traffic is mechanism and
must stay quieter — collapsed to a summary row by default, expanding to a monospace list. `usage` and
`status` events are stored for accounting and provenance but **never rendered as messages**. Promoting
them would drown the channel.

Sidecar ingest is idempotent on `(agentId, sourceRef)`, and duplicates skip their **side effects** too,
or a retried batch double-counts tokens and re-posts messages.

### One shell, and exactly one EventSource

Channels and agents are rooms inside `layouts/app-shell.tsx`, not separate screens. The rail stays put
and only the content area changes, so an agent no longer costs you the channel list and the roster.
`AgentPane` is keyed by agent id, because a route param change re-renders rather than remounts — without
that key a second agent inherits the first one's terminal socket and poll timer.

**The tab opens one `EventSource`, and only `workspace-context.tsx` may construct it.** `/api/stream` is
multiplexed by topic for this reason, and browsers cap connections per origin at about six. A room that
needs its own frames calls `useStreamTopic("channel:<id>", handler)`, which adds a topic to the existing
connection; calling `useChannelStream` anywhere else silently opens a second one that works fine locally
and costs every user a connection for the life of the tab. `tests/unit/one-stream.test.ts` fails if a
second caller appears.

### Auto-approve is a safety surface

A channel's auto-approve switch disables the only human gate on agent→agent dispatch. Flipping it
writes a system message into the transcript, and dispatch cards are still written when it is on —
auto-approve removes the _hold_, not the _record_.

## Sandbox runtimes

| Driver           | When                                    | Notes                                                                                                                 |
| ---------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `runsc` (gVisor) | Default on Linux hosts where registered | Supplies the syscall boundary; do NOT stack a restrictive seccomp profile on top — it causes opaque `ENOSYS` failures |
| `runc`           | Fallback everywhere, incl. macOS/Podman | Full hardening: `CapDrop: ALL` + minimal add-back, `no-new-privileges`, pids/memory caps                              |
| `kata`           | Documented stub                         | Probes availability, throws on create. Its header comment records what a VM boundary changes                          |

`ReadonlyRootfs` is deliberately **false**: agents run package managers constantly, and "hardened
defaults" that stop anything from starting are not hardening.

## Database Migrations

Migrations run automatically on server startup. **`migrate.ts` throws on failure** — leniency only via
`BLACKHOUSE_MIGRATE_LENIENT=1`. A half-applied migration on a booting server is the worst failure mode
in this codebase.

Workflow: edit `src/db/schema.ts` → `npm run db:generate` → commit the SQL. Hand-patch anything
drizzle-kit cannot express (partial indexes, CHECK constraints) and verify the generated SQL.

`src/db/schema.ts` is the real schema; `server/db/schema.ts` only re-exports it.

## Environment Variables

| Variable                                    | Purpose                                       | Default                            |
| ------------------------------------------- | --------------------------------------------- | ---------------------------------- |
| `BETTER_AUTH_SECRET`                        | Auth session signing key (**required**)       | —                                  |
| `BETTER_AUTH_URL`                           | Public URL of the app                         | `http://localhost:3000`            |
| `ADMIN_PASSWORD`                            | Initial admin password                        | random                             |
| `DATABASE_URL`                              | PostgreSQL connection string                  | —                                  |
| `BLACKHOUSE_CONTAINER_URL`                  | URL agent containers use to reach the server  | `http://host.docker.internal:3000` |
| `BLACKHOUSE_NETWORK`                        | Docker network to attach agents to            | —                                  |
| `DOCKER_HOST_SOCKET`                        | Docker/Podman socket path                     | `/var/run/docker.sock`             |
| `BLACKHOUSE_MIGRATE_LENIENT`                | Warn instead of throwing on migration failure | unset                              |
| `BLACKHOUSE_DEBUG_SHELL`                    | Drop to a shell after the agent CLI exits     | unset                              |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth                                  | —                                  |

## Terminal WebSocket Protocol

Binary frames, type byte prefixed:

- `0x00` — terminal data (stdin/stdout)
- `0x01` — resize (client → server, payload `cols:rows`)
- `0x02` — system frame (server → client; currently "a prompt is being injected")

Server broadcasts to all peers (multi-tab). 256KB scrollback replayed on reconnect.

## Development Guidelines

- **Server**: Hono routes in `server/api/`. Use `authMiddleware` / `adminMiddleware`; container-called
  endpoints use the per-agent bearer token instead (`lib/agent-token-auth.ts`).
- **Client**: pages in `src/pages/`, `@/` maps to `src/`. Server uses relative imports.
- **UI**: `@notyet.im/ui` components with inline `style={{}}` over `--ny-*` tokens, matching
  `design/`. No Tailwind classes in new components, no `cn()`/`clsx` — shadcn was removed deliberately.
- **Theme**: `useAppTheme()` from `@/components/theme-provider`. Light and dark are both first-class.
- **i18n**: `t()` keys are type-checked against `src/i18n/locales/en.json`. A new key must be added
  there or the call fails to compile. Use `TranslationKey` for runtime-chosen keys.
- Agents are **workspace-shared**, not owner-scoped: `agents.ownerId` is attribution only. Destructive
  operations gate on `adminMiddleware`.
- Dangerous actions (stop, destroy, delete, enabling auto-approve) need confirmation.
- All pages must be responsive.

## A gotcha that has broken this build twice

A `*/` sequence inside a `/* … */` block comment **terminates the comment early**, turning the rest of
the file into syntax errors. It happens naturally when documenting globs (`**/*.jsonl`) or cron step
values. Reword rather than escaping.
