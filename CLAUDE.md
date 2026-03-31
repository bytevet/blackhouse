# Blackhouse

Coding agent management platform — spawn and manage Docker-containerized coding agents (Claude Code, Codex, Gemini) with terminal access, file explorers, and result viewers.

## Tech Stack

- **Server**: Hono (API routes, WebSocket, static file serving)
- **Client**: React SPA + React Router v7
- **Forms**: Native HTML forms + Zod validation
- **Database**: PostgreSQL + Drizzle ORM
- **Auth**: Better Auth (admin plugin, username plugin, GitHub OAuth)
- **UI**: shadcn/ui (base-mira style, mist color, **base-ui primitives** — NOT Radix) + Tailwind CSS v4
- **Docker**: dockerode for container lifecycle + per-agent preset Dockerfiles
- **Terminal**: xterm.js + binary WebSocket protocol via Hono
- **Build**: Vite (client) + tsx (server)
- **Testing**: Vitest (unit) + Playwright (e2e)

## Project Structure

```
server/                # Hono API server
├── index.ts           # App entry — mounts routes, serves SPA
├── api/               # REST API route handlers
│   ├── auth.ts        # Better Auth mount
│   ├── sessions.ts    # Session CRUD + Docker lifecycle
│   ├── templates.ts   # Template CRUD
│   ├── settings.ts    # Agent configs, Docker, users, profile
│   ├── files.ts       # File explorer + viewer
│   ├── result.ts      # Agent result/title submission (token auth)
│   └── skills.ts      # .well-known/agent-skills endpoint
├── ws/terminal.ts     # WebSocket terminal (binary protocol, multi-peer)
├── middleware/auth.ts  # Auth + admin Hono middleware
├── db/                # Drizzle schema, connection, migrations
└── lib/               # Docker client, Better Auth instance
src/                   # React SPA
├── main.tsx           # Entry point (createRoot + BrowserRouter)
├── App.tsx            # React Router route definitions
├── pages/             # Page components
│   ├── login.tsx
│   ├── dashboard.tsx
│   ├── session.tsx
│   └── settings/, templates/
├── layouts/           # Route layouts (auth guard, tabbed nav)
├── components/        # UI components
│   ├── ui/            # shadcn/ui — DO NOT modify
│   ├── terminal.tsx, file-explorer.tsx, file-viewer.tsx, etc.
├── hooks/             # useTheme, useIsMobile
└── lib/               # api.ts (fetch wrapper), utils, time, auth-client
agent/                 # Injected into coding agent containers
├── dockerfiles/       # Per-agent Dockerfiles
├── entrypoint.sh      # Container entrypoint
└── skills/blackhouse/ # SKILL.md served via .well-known
scripts/seed.ts        # DB seed
```

## Pre-Commit Requirements

**Before every commit, you MUST run these two commands and ensure they pass:**

1. `npm run format:check` — Prettier formatting check
2. `npm test` — Vitest unit tests

If formatting fails, run `npm run format` to auto-fix, then re-stage.

## Commands

```bash
npm run dev            # Start Vite (5173) + Hono (3000) concurrently
npm run dev:client     # Vite dev server only
npm run dev:server     # Hono server only (tsx watch)
npm run build          # Build client + server
npm run start          # Run production server
npm test               # Run unit tests (vitest)
npm run format         # Format code (prettier)
npm run format:check   # Check formatting
npx playwright test    # Run e2e tests
npm run db:generate    # Generate migration from schema changes
npm run db:push        # Push schema directly (dev only)
npm run db:seed        # Seed default data
npm run db:studio      # Open Drizzle Studio
```

## Database Migrations

Migrations run automatically on Hono server startup (`server/index.ts`).

**Workflow for schema changes:**

1. Edit `server/db/schema.ts`
2. Run `npm run db:generate` to create a migration SQL file in `drizzle/`
3. Commit the migration file — it's versioned and auditable
4. On deploy, the server auto-runs pending migrations before accepting requests

Migration files in `drizzle/` are committed to git. Do not use `db:push` in production.

## Environment Variables

| Variable                   | Purpose                                       | Default                            |
| -------------------------- | --------------------------------------------- | ---------------------------------- |
| `BETTER_AUTH_SECRET`       | Auth session signing key (**required**)       | —                                  |
| `BETTER_AUTH_URL`          | Public URL of the app (for auth callbacks)    | `http://localhost:3000`            |
| `ADMIN_PASSWORD`           | Initial admin password (random if omitted)    | —                                  |
| `POSTGRES_PASSWORD`        | Database password                             | `blackhouse`                       |
| `DATABASE_URL`             | PostgreSQL connection string (local dev)      | —                                  |
| `BLACKHOUSE_CONTAINER_URL` | URL agent containers use to reach this server | `http://host.docker.internal:3000` |
| `DOCKER_HOST_SOCKET`       | Docker/Podman socket path                     | `/var/run/docker.sock`             |
| `GITHUB_CLIENT_ID`         | GitHub OAuth app ID (optional)                | —                                  |
| `GITHUB_CLIENT_SECRET`     | GitHub OAuth app secret (optional)            | —                                  |

## Development Guidelines

- **Server**: Hono routes in `server/api/`. Use `authMiddleware` or `adminMiddleware` from `server/middleware/auth.ts`
- **Client**: React pages in `src/pages/`. Use `client` from `src/lib/api.ts` (hono/client RPC) for type-safe server calls
- **Forms**: Native `<form onSubmit>` + `useState` for state + `z.safeParse()` for validation. No form libraries.
- **Routing**: React Router v7 — `Link`, `useNavigate`, `useParams`, `useLocation` from `react-router`
- **UI**: shadcn/ui components exclusively — never create custom UI primitives
- **Imports**: `@/` alias maps to `src/` (client only). Server uses relative imports.
- **Types**: `server/db/schema.ts` exports `CodingSession`, `Template`, `AgentConfig`, `User`
- All pages must be responsive
- Dangerous actions (stop, destroy, delete) must have confirmation
- **Base-UI Select requires `items` prop** — NOT Radix. Read docs at https://ui.shadcn.com/docs/components/base/select

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
