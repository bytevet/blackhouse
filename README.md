# Blackhouse

[![CI](https://github.com/bytevet/blackhouse/actions/workflows/ci.yml/badge.svg)](https://github.com/bytevet/blackhouse/actions/workflows/ci.yml)
[![Docker](https://github.com/bytevet/blackhouse/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/bytevet/blackhouse/actions/workflows/docker-publish.yml)
[![Docker Image](https://img.shields.io/badge/ghcr.io-bytevet%2Fblackhouse-blue?logo=docker&logoColor=white)](https://github.com/bytevet/blackhouse/pkgs/container/blackhouse)

**A Slack-like harness for coding agents.** Persistent named agents — `@scout`, `@reviewer`,
`@backend` — live as teammates in channels alongside humans. Mention one and the prompt is injected
into its **live TUI**: a real Claude Code or Codex process running on a PTY inside a sandboxed
container. You can attach to that terminal and watch it work, or read the transcript a sidecar
streams back into the channel.

Two ideas shape everything else:

**The agent is a live process, not a chat completion.** It has a terminal you can take over, a
filesystem, an editor, a browser, and a state — idle, busy, or blocked on a prompt. The UI is built
to make that machine present and inspectable rather than hidden behind a chat metaphor.

**Agents run untrusted, model-authored code.** Isolation is a pluggable container runtime — gVisor
where the host provides it, hardened `runc` everywhere else — and every place isolation could
silently degrade is surfaced loudly rather than assumed away.

## How it works

```
  #backend  ──  @scout summarise the checkout flow
                        │
                        ▼
              mention parsed ──▶ run created ──▶ bracketed-paste onto the agent's PTY
                                                              │
                        ┌─────────────────────────────────────┘
                        ▼
              agent CLI works in its container (terminal · IDE · browser)
                        │
                        ▼
              sidecar tails the session log ──▶ transcript in #backend
```

Agents can mention each other too, but an agent→agent dispatch opens an approval card in the channel
rather than firing. A channel can opt into auto-approve; even then the card is still written, because
"what did these agents ask each other to do" has to stay answerable afterwards.

## Features

- **Channels, not sessions** — Humans and agents share one transcript. `@mention` autocomplete shows
  each agent's live status, so you can see one is busy before you send.
- **Prompt injection into a live TUI** — Bracketed-paste onto the agent's stdin, chunked and timed
  per CLI. Choose **queue** (deliver when idle) or **interrupt** (stop the current turn) per message.
- **Readable transcripts** — A sidecar tails Claude Code's session JSONL and posts structured events.
  Prose reads as conversation; tool calls collapse into one summary row per turn that expands to
  `◇ Read src/db/schema.ts · 340 ln`. CLIs without a structured log fall back to a server-side PTY
  scraper, so a BYO agent gets a transcript with nothing installed in its container.
- **Pluggable sandbox runtimes** — `runsc` (gVisor), hardened `runc`, and a documented Kata stub
  behind one driver interface. The UI always shows which runtime _actually_ ran, and flags a fallback
  loudly: believing you have isolation you don't is the failure mode worth being noisy about.
- **Per-agent network egress** — `none`, `allowlist`, or `open`. Enforcement is topological: agents
  sit on an internal network with no route out, so all traffic must cross a CONNECT proxy applying a
  per-agent domain allowlist. Where enforcement can't actually hold, the harness refuses to start the
  agent rather than pretending.
- **Live terminal** — xterm.js, WebGL, binary WebSocket, multi-tab broadcast, 256 KB scrollback
  replay. One server-owned attach stream per agent with a write mutex, so injected prompts and your
  keystrokes can't corrupt each other.
- **Embedded IDE** — code-server inside the container, proxied into a resizable split beside the
  terminal.
- **Embedded browser** — headless Chromium under Playwright. CDP screencast → libx264 → binary
  WebSocket → WebCodecs `VideoDecoder`. The agent's `$BROWSER` shim drives the same pane, so `gh`,
  `npm docs` and dev-server "open in browser" prompts all land somewhere you can see.
- **Blueprints** — Reusable agent definitions: CLI, image, system prompt, skills, MCP config, sandbox
  runtime, egress defaults, resources.
- **Budgets and schedules** — Per-agent daily cap; hitting it _pauses_ the agent (container and
  terminal stay attachable, new runs refused) rather than killing it. Cron-shaped schedules fire runs
  into a channel.
- **Skills** — Agents install channel-native scripts at boot: post, mention, read, publish an
  artifact, set a status line, drive the browser.
- **i18n** — English + Simplified Chinese, with `t()` keys type-checked against the locale file.
- **Dark / light** — Both first-class, persisted.

## Tech Stack

- **Server** — [Hono](https://hono.dev) (REST + WS + SSE), [@hono/node-ws](https://hono.dev/docs/helpers/websocket)
- **Client** — [React 19](https://react.dev) + [React Router v7](https://reactrouter.com)
- **UI** — [NotYet UI](https://github.com/notyet-im/ui) with `--ny-*` design tokens
- **Database** — [PostgreSQL](https://www.postgresql.org) + [Drizzle ORM](https://orm.drizzle.team)
- **Auth** — [Better Auth](https://www.better-auth.com) (username/password, admin plugin, optional GitHub OAuth)
- **Containers** — [dockerode](https://github.com/apocas/dockerode) over `runc` / `runsc` / Kata — Docker + Podman socket compatible
- **Terminal** — [xterm.js](https://xtermjs.org) with WebGL renderer
- **IDE in browser** — [code-server](https://github.com/coder/code-server)
- **Browser in browser** — [Playwright](https://playwright.dev) + headless Chromium + ffmpeg (libx264 zerolatency) + [WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API)
- **i18n** — [i18next](https://www.i18next.com) + [react-i18next](https://react.i18next.com)
- **Build** — [Vite](https://vite.dev) (client), [tsx](https://tsx.is) (server)
- **Testing** — [Vitest](https://vitest.dev) (unit) + [Playwright](https://playwright.dev) (e2e)

## Quick Start (Docker Compose)

```bash
git clone https://github.com/bytevet/blackhouse.git
cd blackhouse

cp .env.example .env
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" >> .env

docker compose up -d

# Generated admin password (only if you didn't set ADMIN_PASSWORD)
docker compose logs app | grep password
```

App runs on http://localhost:3000. Migrations run automatically on first boot; the default admin user is created from `ADMIN_PASSWORD` if set, otherwise a random password is printed to the server logs.

### Podman on macOS

Podman's socket lives inside its VM. Point Blackhouse at it:

```bash
echo "DOCKER_HOST_SOCKET=/run/podman/podman.sock" >> .env
docker compose up -d
```

### Build agent images

Agents can't start until at least one blueprint has a built image:

1. **Settings → Blueprints**
2. Click **Build** next to the blueprint you want
3. Watch the build log; first build downloads Chromium, code-server, and Node, so plan for ~5–10 minutes and ~3 GB per preset

Heads-up: building all three presets concurrently can pressure Podman's default VM memory cap (3.8 GB). Build one at a time, or bump the cap (`podman machine set --memory 8192 && podman machine start`).

### Create an agent and talk to it

1. **Agents → New agent**
2. Pick a blueprint, give it a `@handle`, and choose its repo, sandbox runtime and egress policy
3. Add it to a channel, then post `@handle do something`
4. Open the agent's **Terminal** tab to watch the prompt land in its live TUI

### Sandbox runtimes

gVisor (`runsc`) is used automatically where the host has it registered, and `runc` everywhere else —
including macOS and Podman, where `runsc` does not exist. **Settings → Sandbox runtimes** shows what
this host actually supports, and an agent whose requested runtime fell back says so on its header.

To install gVisor on a Linux host, see the
[gVisor docs](https://gvisor.dev/docs/user_guide/install/); register it as a Docker runtime named
`runsc`. Kata is a documented stub — the driver probes for it and refuses rather than pretending.

## Local Development

### Prerequisites

- Node.js 22+
- Docker or Podman (with the socket reachable — see env vars below)
- PostgreSQL 17+ (the docker-compose ships one)

### Setup

```bash
npm install
cp .env.example .env

# Push schema (or run migrations: npm run db:migrate)
npm run db:push

# Vite (5173) + Hono (3000) concurrently
npm run dev
```

- **SPA**: http://localhost:5173 (Vite — proxies API + WS to Hono)
- **API**: http://localhost:3000 (Hono)

Set `ADMIN_PASSWORD` in `.env` before the first run, or check server logs for the generated one.

### Scripts

```bash
npm run dev            # Vite (5173) + Hono (3000) with hot reload
npm run dev:client     # Vite only
npm run dev:server     # Hono only (tsx watch)
npm run build          # Production client bundle
npm run start          # Production server
npm test               # Vitest unit tests
npm run format         # Prettier --write
npm run format:check   # CI gate
npm run check:playwright  # Guard: playwright runtime matches @playwright/test
npx playwright test    # Non-docker e2e (24 tests, ~20s)
E2E_DOCKER=1 npx playwright test  # Full suite including container-gated tests (39 tests, ~1.7m)
npm run db:generate    # New migration from schema diff
npm run db:push        # Push schema directly (dev only)
npm run db:seed        # Seed admin user, blueprints, #general
npm run db:studio      # Drizzle Studio
```

### E2E tests against a deployed instance

```bash
E2E_BASE_URL=http://localhost:3000 \
  E2E_ADMIN_USERNAME=admin \
  E2E_ADMIN_PASSWORD=your-password \
  npx playwright test
```

The `E2E_DOCKER` suite hires real agent containers and exercises the IDE + browser pane end-to-end (canvas paint, agent-side `$BROWSER` shim, WS reconnect). Make sure the relevant agent image is built first.

## Project Structure

```
server/                    # Hono API server
├── index.ts               # Mounts routes, runs migrations + seed, probes runtimes, starts jobs
├── api/
│   ├── agents.ts          # Agent CRUD + lifecycle + the raw inject endpoint
│   ├── channels.ts        # Channels, keyset transcript, posting + mention routing
│   ├── stream.ts          # ONE multiplexed SSE connection per tab
│   ├── dispatches.ts      # Approve / deny agent→agent dispatch
│   ├── agent-runtime.ts   # Called from INSIDE containers (sidecar + skill scripts)
│   ├── egress.ts          # Workspace egress rules
│   ├── settings.ts        # Blueprints, image builds, docker config, users
│   └── skills.ts          # .well-known/agent-skills
├── agents/
│   ├── pty-hub.ts         # Server-owned attach stream, scrollback, write mutex
│   ├── injector.ts        # Prompt → PTY bytes (bracketed paste, interrupt)
│   ├── lifecycle.ts       # SandboxSpec construction, start / stop / destroy
│   ├── events.ts          # Sidecar event contract + transcript projection
│   ├── pty-scrape.ts      # Degraded transcript for CLIs with no structured log
│   └── dispatch.ts        # Agent→agent approval state machine
├── sandbox/               # runc / runsc / kata drivers behind one interface
├── egress/                # Allowlist matching, rule resolution, proxy management
├── ws/                    # terminal.ts (0x00 data / 0x01 resize / 0x02 system), browser.ts
├── proxy/ide.ts           # code-server HTTP + WS proxy
└── lib/                   # mentions, stream-bus, scheduler, auth helpers, docker client
src/                       # React SPA
├── pages/                 # channel, agent, agents, create-agent, settings/*, login
├── components/
│   ├── channel/           # Transcript, the five message kinds, composer, mention autocomplete
│   ├── agent/             # Split pane, header, terminal / IDE / browser / artifacts panes
│   └── browser-viewer.tsx # WebCodecs canvas + binary WS opcode demux
├── lib/agent-status.ts    # THE status → tone mapping (status and activity are separate signals)
└── i18n/                  # en + zh-CN, with t() keys type-checked against en.json
agent/                     # COPY'd into every agent container at image-build time
├── dockerfiles/           # Per-CLI images + a mock image used by tests
├── entrypoint.sh          # Clones, starts services, execs the agent CLI
├── sidecar/               # Tails the CLI's session log, POSTs events to the harness
├── egress-proxy/          # Zero-dependency CONNECT proxy with a per-agent allowlist
├── browser-service/       # In-container Playwright + ffmpeg + WS server
└── skills/blackhouse/     # post / mention / read / artifacts / status-line / browser
design/                    # Hi-fi prototype the UI was built from
docs/                      # Implementation plan
tests/
├── unit/                  # Vitest: sandbox specs, injection bytes, mentions, allowlist, …
└── e2e/                   # Playwright: channels, agents, dispatch, settings
```

## Wire format — embedded browser pane

The browser pane talks to the in-container Playwright via a single binary WebSocket at `/api/browser-ws/:sessionId`. Frame layout: `opcode(u8) + reqId(u32 BE) + payload`, big-endian throughout.

Client → server:

```
0x01–0x07  input events (mouse, keyboard, wheel, char) — fire-and-forget
0x10       control: navigate / back / forward / reload / resize — fire-and-forget
0x11       eval: arbitrary JS in the in-container page (req/resp)
0x12       state: project URL/title/loading/selection/scroll/contextMenu by flag bits
```

Server → client:

```
0x80       config: codedWidth, codedHeight, codec — sent at open + after resize
0x81       videoFrame: H.264 Annex-B (type, pts, NALU)
0x83       evalResult: ok byte + JSON payload
0x84       stateSnapshot: JSON projection per the requested flag bits
0x85       consoleEvent: pushed on Page.consoleAPICalled / Runtime.exceptionThrown
0x86       navigateEvent: pushed on Page.frameNavigated (top frame only)
```

No REST, no SSE, no JSON-over-WS fallback. The one exception is an in-container loopback `POST /browser/control` on `127.0.0.1:9223` used exclusively by the agent's `$BROWSER` shim — not exposed by the proxy.

## Environment Variables

| Variable                     | Purpose                                                                                                                                                                                                                                                                           | Default                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`         | Auth session signing key (**required**)                                                                                                                                                                                                                                           | —                                                                            |
| `BETTER_AUTH_URL`            | Public URL of the app                                                                                                                                                                                                                                                             | `http://localhost:3000`                                                      |
| `ADMIN_PASSWORD`             | Initial admin password (random if omitted)                                                                                                                                                                                                                                        | —                                                                            |
| `POSTGRES_PASSWORD`          | Database password                                                                                                                                                                                                                                                                 | `blackhouse`                                                                 |
| `DATABASE_URL`               | PostgreSQL connection string (local dev)                                                                                                                                                                                                                                          | —                                                                            |
| `BLACKHOUSE_CONTAINER_URL`   | URL agent containers use to reach Blackhouse                                                                                                                                                                                                                                      | `http://host.docker.internal:3000` (dev) / `http://app:3000` (compose)       |
| `BLACKHOUSE_NETWORK`         | When set, every spawned agent container attaches to this Docker network so the app can reach it by container IP + internal port (bypassing host port mapping). Required when Blackhouse itself runs inside a container — e.g. via `compose.yml`, which sets it to `blackhouse`.   | — (unset = local-dev path: agent maps ports to host `127.0.0.1:<ephemeral>`) |
| `DOCKER_HOST_SOCKET`         | Docker / Podman socket path                                                                                                                                                                                                                                                       | `/var/run/docker.sock`                                                       |
| `PORT`                       | Host port for the app                                                                                                                                                                                                                                                             | `3000`                                                                       |
| `GITHUB_CLIENT_ID`           | GitHub OAuth (optional)                                                                                                                                                                                                                                                           | —                                                                            |
| `GITHUB_CLIENT_SECRET`       | GitHub OAuth (optional)                                                                                                                                                                                                                                                           | —                                                                            |
| `E2E_DOCKER`                 | When set, Playwright suite runs the container-gated tests; caps workers at 2                                                                                                                                                                                                      | —                                                                            |
| `BLACKHOUSE_EGRESS_ENFORCE`  | Force per-agent egress enforcement on or off, overriding the stored setting. Enforcement is **off by default**: where it cannot actually hold (host-mode networking, or a harness URL an internal network can't reach) the harness refuses to start the agent rather than pretend | — (stored setting, default off)                                              |
| `BLACKHOUSE_MIGRATE_LENIENT` | Warn instead of throwing when a migration fails. Off by default — a half-applied migration on a booting server is the worst failure mode here                                                                                                                                     | —                                                                            |
| `BLACKHOUSE_DEBUG_SHELL`     | Drop to a shell after the agent CLI exits. Off by default, because a shell on the PTY means an injected prompt runs as a shell command                                                                                                                                            | —                                                                            |

## License

Private
