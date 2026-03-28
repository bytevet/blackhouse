# Blackhouse

Coding agent management platform — spawn and manage Docker-containerized coding agents (Claude Code, Codex, Gemini) with terminal access, file explorers, and result viewers.

## Tech Stack

- **Framework**: TanStack Start (full-stack SSR with file-based routing)
- **Database**: PostgreSQL + Drizzle ORM
- **Auth**: Better Auth (admin plugin, username plugin, GitHub OAuth)
- **UI**: shadcn/ui (base-mira style, mist color) + Tailwind CSS v4
- **Docker**: dockerode for container lifecycle
- **Terminal**: xterm.js + WebSocket via Nitro
- **Testing**: Vitest (unit) + Playwright (e2e)

## Project Structure

```
src/
├── components/     # React components (app-sidebar, terminal, file-explorer, etc.)
│   └── ui/         # shadcn/ui components — DO NOT modify these
├── db/             # Drizzle schema and connection
├── lib/            # Shared utilities (auth, docker, utils, session-status)
├── mcp/            # MCP result server (injected into containers)
├── routes/         # TanStack file-based routes
│   ├── _authed/    # Auth-protected routes (dashboard, templates, settings, sessions)
│   └── api/        # API routes (auth, health, sessions)
├── server/         # Server functions (sessions, templates, settings, files, terminal)
server/             # Nitro server routes (WebSocket terminal handler)
tests/
├── e2e/            # Playwright e2e tests
└── unit/           # Vitest unit tests
```

## Pre-Commit Requirements

**Before every commit, you MUST run these two commands and ensure they pass:**

1. `npm run format:check` — Prettier formatting check
2. `npm test` — Vitest unit tests (66 tests)

If formatting fails, run `npm run format` to auto-fix, then re-stage.

## Commands

```bash
npm run dev          # Start dev server (port 3000)
npm run build        # Production build
npm test             # Run unit tests (vitest)
npm run format       # Format code (prettier)
npm run format:check # Check formatting
npx playwright test  # Run e2e tests (requires dev server)
npm run db:push      # Push schema to database
npm run db:seed      # Seed default data
npm run db:studio    # Open Drizzle Studio
```

## Development Guidelines

- Use shadcn/ui components exclusively — never create custom UI primitives
- Use `@/` path alias for all imports (maps to `src/`)
- Server functions use `createServerFn` from `@tanstack/react-start`
- Callers pass data as `{ data: { ... } }` to server functions with `inputValidator`
- Auth helpers are centralized in `src/lib/auth-server.ts` (`requireSession`, `requireAdmin`, `requireSessionOwnership`)
- Use types from `src/db/schema.ts` (`CodingSession`, `Template`, `AgentConfig`, `User`, `SessionStatus`)
- Session status styles are in `src/lib/session-status.ts`
- `timeAgo()` utility is in `src/lib/time.ts` (NOT in utils.ts — shadcn init overwrites utils.ts)
- CSS variables for theming are in `src/index.css` — border overrides must be unlayered (not in `@layer base`) to beat Tailwind v4 preflight
- All pages must be responsive — use `hidden sm:table-cell` for table columns, `md:flex-row` for layout switches

## Do Not Modify (shadcn/ui managed files)

These files are generated and managed by shadcn/ui. Do not edit them manually — they will be overwritten by `npx shadcn init` or `npx shadcn add`.

- `src/lib/utils.ts` — only contains `cn()`, managed by shadcn. Put custom utilities in separate files (e.g. `src/lib/time.ts`).
- `src/components/ui/*` — all files in this directory are shadcn/ui components. Never modify them directly.
