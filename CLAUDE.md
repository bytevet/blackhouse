# Blackhouse

Coding agent management platform — spawn and manage Docker-containerized coding agents (Claude Code, Codex, Gemini) with terminal access, file explorers, and result viewers.

## Tech Stack

- **Framework**: TanStack Start (SPA mode, file-based routing, server functions, Zod validation)
- **Forms**: TanStack Form + shadcn/ui Field components
- **Database**: PostgreSQL + Drizzle ORM
- **Auth**: Better Auth (admin plugin, username plugin, GitHub OAuth)
- **UI**: shadcn/ui (base-mira style, mist color, **base-ui primitives** — NOT Radix) + Tailwind CSS v4
- **Docker**: dockerode for container lifecycle + per-agent preset Dockerfiles
- **Terminal**: xterm.js + binary WebSocket protocol via Nitro
- **Testing**: Vitest (unit) + Playwright (e2e)

## Project Structure

```
src/
├── components/        # React components
│   ├── ui/            # shadcn/ui components — DO NOT modify
│   ├── app-header.tsx # Header nav bar
│   ├── terminal.tsx   # xterm.js terminal (dynamic import, binary protocol)
│   ├── file-explorer.tsx
│   ├── file-viewer.tsx
│   └── result-viewer.tsx
├── db/                # Drizzle schema (schema.ts) and connection (index.ts)
├── lib/               # Shared utilities
│   ├── agent-presets.ts  # Preset configs (Claude Code, Gemini, Codex, Custom)
│   ├── auth-server.ts    # getServerSession (createServerFn for route guards)
│   ├── auth-client.ts    # Client-side auth hooks
│   ├── session-status.ts # Status badge colors
│   ├── time.ts           # timeAgo() — NOT in utils.ts (shadcn overwrites it)
│   └── docker.ts         # Docker client singleton
├── routes/
│   ├── __root.tsx     # Root route (auth context, error/notFound components)
│   ├── _authed.tsx    # Auth guard layout (redirects to /login?redirect=)
│   ├── _authed/
│   │   ├── dashboard.tsx
│   │   ├── sessions/$sessionId.tsx  # Terminal + resizable file explorer
│   │   ├── settings.tsx             # Layout with sub-route nav
│   │   ├── settings/{profile,agents,docker,users}.tsx
│   │   ├── templates.tsx            # Layout with sub-route nav
│   │   └── templates/{mine,public}.tsx
│   ├── login.tsx
│   └── api/           # API routes (auth, health, sessions/result)
├── server/
│   ├── middleware.ts   # authMiddleware + adminMiddleware (createMiddleware)
│   ├── sessions.ts     # Session CRUD + Docker container lifecycle
│   ├── templates.ts    # Template CRUD
│   ├── settings.ts     # Agent configs, Docker config, user management
│   └── files.ts        # File explorer via Docker exec
server/
└── routes/
    ├── api/terminal/[sessionId].ts      # WebSocket terminal (binary protocol, multi-peer)
    └── .well-known/agent-skills/        # Skills API for `npx skills add`
agent/                 # Everything injected into coding agent containers
├── dockerfiles/       # Per-agent preset Dockerfiles (claude-code, gemini, codex)
├── entrypoint.sh      # Container entrypoint (git clone, skills install, agent start)
└── skills/blackhouse/ # SKILL.md served via .well-known/agent-skills/ endpoint
scripts/
└── seed.ts            # DB seed (admin user + agent presets)
```

## Pre-Commit Requirements

**Before every commit, you MUST run these two commands and ensure they pass:**

1. `npm run format:check` — Prettier formatting check
2. `npm test` — Vitest unit tests

If formatting fails, run `npm run format` to auto-fix, then re-stage.

## Commands

```bash
npm run dev          # Start dev server (port 3000)
npm run build        # Production build
npm test             # Run unit tests (vitest)
npm run format       # Format code (prettier)
npm run format:check # Check formatting
npx playwright test  # Run e2e tests (requires dev server)
npm run db:generate  # Generate migration from schema changes
npm run db:push      # Push schema directly (dev only)
npm run db:seed      # Seed default data (admin user + agent presets)
npm run db:studio    # Open Drizzle Studio
```

## Database Migrations

Migrations run automatically on server startup via a Nitro plugin (`server/plugins/migrate.ts`).

**Workflow for schema changes:**

1. Edit `src/db/schema.ts`
2. Run `npm run db:generate` to create a migration SQL file in `drizzle/`
3. Commit the migration file — it's versioned and auditable
4. On deploy, the server auto-runs pending migrations before accepting requests

Migration files in `drizzle/` are committed to git. Do not use `db:push` in production.

## Environment Variables

| Variable                   | Purpose                                       | Default                            |
| -------------------------- | --------------------------------------------- | ---------------------------------- |
| `DATABASE_URL`             | PostgreSQL connection string                  | —                                  |
| `BETTER_AUTH_SECRET`       | Auth session signing key                      | —                                  |
| `BETTER_AUTH_URL`          | Public URL of the app (for auth callbacks)    | `http://localhost:3000`            |
| `BLACKHOUSE_CONTAINER_URL` | URL agent containers use to reach this server | `http://host.docker.internal:3000` |
| `GITHUB_CLIENT_ID`         | GitHub OAuth app ID                           | —                                  |
| `GITHUB_CLIENT_SECRET`     | GitHub OAuth app secret                       | —                                  |

For Docker Compose, set `BLACKHOUSE_CONTAINER_URL` to the app's service name (e.g., `http://blackhouse:3000`).

## Development Guidelines

- Use shadcn/ui components exclusively — never create custom UI primitives
- Use `@/` path alias for all imports (maps to `src/`)
- Server functions use `createServerFn` with `.middleware([authMiddleware])` and `.inputValidator(zodSchema)`
- Auth middleware is in `src/server/middleware.ts` — use `authMiddleware` or `adminMiddleware`
- Each server function handler receives `{ data, context }` where `context.session` comes from middleware
- Forms use `useForm` from `@tanstack/react-form` with `Field`/`FieldLabel`/`FieldError` from shadcn
- Use types from `src/db/schema.ts` (`CodingSession`, `Template`, `AgentConfig`, `User`)
- Agent presets are in `src/lib/agent-presets.ts` (Claude Code, Gemini, Codex, Custom)
- `timeAgo()` is in `src/lib/time.ts` (NOT in utils.ts — shadcn init overwrites utils.ts)
- CSS variables for theming are in `src/index.css`
- All pages must be responsive
- Dangerous actions (stop, destroy, delete) must have confirmation dialogs
- **Base-UI Select requires `items` prop** — `<Select items={[{label, value}]}>` is mandatory for `<SelectValue>` to display the label instead of the raw value. This is NOT Radix — base-ui has a different API. Always read the base-ui variant docs at https://ui.shadcn.com/docs/components/base/select

## Terminal WebSocket Protocol

Binary frame protocol — all messages have a type byte prefix:

- `0x00` = terminal data (stdin/stdout)
- `0x01` = resize command (client → server, payload: `cols:rows`)

Server broadcasts to all connected peers (multi-tab support). 256KB scrollback buffer replayed on reconnect.

## Do Not Modify (shadcn/ui managed files)

- `src/lib/utils.ts` — only contains `cn()`, managed by shadcn
- `src/components/ui/*` — all shadcn/ui components

## shadcn/ui Usage Rules

- **Trust shadcn/ui components** — they work correctly. If something isn't working, the issue is in how you're using them.
- **Never modify `src/components/ui/*`** — never add forwardRef wrappers, change props, or alter behavior.
- **Never create custom alternatives** — don't build custom drag handles, selects, or components that replace shadcn/ui.
- **Read the docs first** — fetch latest docs from https://ui.shadcn.com using Context7 before using or debugging.
- **Ask the user if stuck** — don't attempt multiple workarounds. If two attempts fail, ask.
