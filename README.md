# Blackhouse

Coding agent management platform — spawn and manage Docker-containerized coding agents (Claude Code, Gemini, Codex) with real-time terminal access, file explorers, and result viewers.

## Features

- **Agent Presets** — Claude Code, Gemini, Codex with pre-configured Dockerfiles, commands, and credential volumes
- **Interactive Terminal** — xterm.js with WebGL rendering, binary WebSocket protocol, multi-tab sync, and scrollback replay
- **Session Management** — Create, stop, restart, destroy coding sessions with Docker containers
- **File Explorer** — Browse files, view syntax-highlighted content, see git diffs and status indicators
- **Result Viewer** — Agents submit rich HTML results viewable in a sandboxed iframe
- **Skills System** — Agents auto-install skills via `npx skills add` from `.well-known/agent-skills/` endpoint
- **Template System** — Reusable prompt templates with system prompts and git requirements
- **Role-Based Access** — Admin and user roles with per-route guards
- **Dark/Light Mode** — Theme toggle with persistence
- **Responsive** — Desktop and mobile layouts with resizable panels

## Tech Stack

- **Server**: [Hono](https://hono.dev) — API routes, WebSocket, static file serving
- **Client**: [React](https://react.dev) + [React Router v7](https://reactrouter.com) — SPA with client-side routing
- **UI**: [shadcn/ui](https://ui.shadcn.com) (base-ui primitives) + [Tailwind CSS v4](https://tailwindcss.com)
- **Database**: [PostgreSQL](https://www.postgresql.org) + [Drizzle ORM](https://orm.drizzle.team)
- **Auth**: [Better Auth](https://www.better-auth.com) — username/password + GitHub OAuth
- **Docker**: [dockerode](https://github.com/apocas/dockerode) — container lifecycle management
- **Terminal**: [xterm.js](https://xtermjs.org) — WebGL-accelerated terminal emulator
- **Build**: [Vite](https://vite.dev) (client) + [tsx](https://tsx.is) (server)

## Getting Started

### Prerequisites

- Node.js 22+
- Docker
- PostgreSQL

### Setup

```bash
# Install dependencies
npm install

# Copy environment config
cp .env.example .env

# Push database schema
npm run db:push

# Seed default data (admin user + agent presets)
npm run db:seed

# Start dev servers
npm run dev
```

- **SPA**: http://localhost:5173 (Vite — proxies API calls to Hono)
- **API**: http://localhost:3000 (Hono server)

Default admin credentials: `admin` / `admin123`

### Build Agent Images

Before creating sessions, build Docker images for each agent preset:

1. Go to **Settings > Coding Agents**
2. Click **Build** for each agent
3. Wait for the build to complete

### Create a Session

1. Go to **Dashboard**
2. Click **New Session**
3. Select a built agent, optionally choose a template and git repo
4. Terminal connects to the agent automatically

## Scripts

```bash
npm run dev            # Vite (5173) + Hono (3000) concurrently
npm run dev:client     # Vite dev server only
npm run dev:server     # Hono server only (tsx watch)
npm run build          # Build client for production
npm run start          # Start production server
npm test               # Unit tests (Vitest)
npx playwright test    # E2E tests (Playwright)
npm run format         # Prettier
npm run db:generate    # Generate migration from schema changes
npm run db:push        # Push schema directly (dev only)
npm run db:seed        # Seed admin user + agent presets
npm run db:studio      # Drizzle Studio
```

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
├── ws/terminal.ts     # WebSocket terminal handler
├── middleware/auth.ts  # Auth + admin Hono middleware
├── db/                # Drizzle schema, connection, migrations
└── lib/               # Docker client, Better Auth instance
src/                   # React SPA
├── main.tsx           # Entry point
├── App.tsx            # React Router route definitions
├── pages/             # Page components
├── layouts/           # Auth guard, settings/templates tabbed nav
├── components/        # Terminal, file explorer, file viewer, etc.
│   └── ui/            # shadcn/ui components (do not modify)
├── hooks/             # useTheme, useIsMobile
└── lib/               # API client, utilities, auth client
agent/                 # Injected into coding agent containers
├── dockerfiles/       # Per-agent Dockerfiles
├── entrypoint.sh      # Container entrypoint
└── skills/            # SKILL.md served via .well-known
```

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `DATABASE_URL` | PostgreSQL connection string | — |
| `BETTER_AUTH_SECRET` | Auth session signing key | — |
| `BETTER_AUTH_URL` | Public URL (auth callbacks) | `http://localhost:3000` |
| `BLACKHOUSE_CONTAINER_URL` | URL containers use to reach server | `http://host.docker.internal:3000` |
| `GITHUB_CLIENT_ID` | GitHub OAuth (optional) | — |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth (optional) | — |

## License

Private
