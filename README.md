# Blackhouse

[![CI](https://github.com/bytevet/blackhouse/actions/workflows/ci.yml/badge.svg)](https://github.com/bytevet/blackhouse/actions/workflows/ci.yml)
[![Docker](https://github.com/bytevet/blackhouse/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/bytevet/blackhouse/actions/workflows/docker-publish.yml)
[![Docker Image](https://ghcr-badge.egpl.dev/bytevet/blackhouse/latest_tag?trim=major&label=image)](https://github.com/bytevet/blackhouse/pkgs/container/blackhouse)

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
- **Type-Safe API** — Hono RPC client with end-to-end type inference
- **Dark/Light Mode** — Theme toggle with persistence
- **Responsive** — Desktop and mobile layouts with resizable panels

## Tech Stack

- **Server**: [Hono](https://hono.dev) — RESTful API routes, WebSocket, static file serving
- **Client**: [React](https://react.dev) + [React Router v7](https://reactrouter.com) — SPA with type-safe [hono/client](https://hono.dev/docs/guides/rpc) RPC
- **UI**: [shadcn/ui](https://ui.shadcn.com) (base-ui primitives) + [Tailwind CSS v4](https://tailwindcss.com)
- **Database**: [PostgreSQL](https://www.postgresql.org) + [Drizzle ORM](https://orm.drizzle.team)
- **Auth**: [Better Auth](https://www.better-auth.com) — username/password + GitHub OAuth
- **Docker**: [dockerode](https://github.com/apocas/dockerode) — container lifecycle management
- **Terminal**: [xterm.js](https://xtermjs.org) — WebGL-accelerated terminal emulator
- **Build**: [Vite](https://vite.dev) (client) + [tsx](https://tsx.is) (server)
- **Testing**: [Vitest](https://vitest.dev) (unit) + [Playwright](https://playwright.dev) (e2e)

## Quick Start (Docker Compose)

```bash
# Clone and enter the project
git clone https://github.com/bytevet/blackhouse.git
cd blackhouse

# Create .env from template
cp .env.example .env

# Generate a secret key (required)
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" >> .env

# Start the stack
docker-compose up -d

# Check logs for the generated admin password
docker-compose logs app | grep password
```

The app is available at http://localhost:3000. On first startup, migrations run automatically and a default admin user is created.

### Podman (macOS)

```bash
# Set the VM-internal socket path
echo "DOCKER_HOST_SOCKET=/run/podman/podman.sock" >> .env
docker-compose up -d
```

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

## Local Development

### Prerequisites

- Node.js 22+
- Docker or Podman
- PostgreSQL

### Setup

```bash
# Install dependencies
npm install

# Copy environment config
cp .env.example .env

# Push database schema
npm run db:push

# Start dev servers (seeds automatically on first run)
npm run dev
```

- **SPA**: http://localhost:5173 (Vite — proxies API calls to Hono)
- **API**: http://localhost:3000 (Hono server)

Set `ADMIN_PASSWORD` in `.env` before first run, or check server logs for the generated password.

### Scripts

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

### E2E Tests

```bash
# Against dev server (starts automatically)
npx playwright test

# Against docker-compose deployment
E2E_BASE_URL=http://localhost:3000 E2E_ADMIN_PASSWORD=your-password npx playwright test
```

## Project Structure

```
server/                # Hono API server
├── index.ts           # App entry — mounts routes, serves SPA, runs migrations + seed
├── api/               # RESTful API route handlers (chained for RPC type inference)
│   ├── auth.ts        # Better Auth mount
│   ├── sessions.ts    # Session CRUD + Docker lifecycle
│   ├── templates.ts   # Template CRUD
│   ├── settings.ts    # Agent configs, Docker, users, profile, volumes
│   ├── files.ts       # File explorer + viewer
│   ├── result.ts      # Agent result/title submission (token auth)
│   └── skills.ts      # .well-known/agent-skills endpoint
├── ws/terminal.ts     # WebSocket terminal (binary protocol, multi-peer)
├── middleware/auth.ts  # Auth + admin Hono middleware
├── db/                # Drizzle schema, connection, migrations, seed
└── lib/               # Docker client, Better Auth instance, pagination
src/                   # React SPA
├── main.tsx           # Entry point (createRoot + BrowserRouter)
├── App.tsx            # React Router route definitions
├── pages/             # Page components
├── layouts/           # Auth guard, settings/templates tabbed nav
├── components/        # Terminal, file explorer, file viewer, etc.
│   └── ui/            # shadcn/ui components (do not modify)
├── hooks/             # useTheme, useIsMobile
└── lib/               # hono/client RPC, shiki highlighter, utilities
agent/                 # Injected into coding agent containers
├── dockerfiles/       # Per-agent Dockerfiles
├── entrypoint.sh      # Container entrypoint
└── skills/            # SKILL.md served via .well-known
```

## Environment Variables

| Variable                   | Purpose                                    | Default                            |
| -------------------------- | ------------------------------------------ | ---------------------------------- |
| `BETTER_AUTH_SECRET`       | Auth session signing key (**required**)    | —                                  |
| `BETTER_AUTH_URL`          | Public URL of the app                      | `http://localhost:3000`            |
| `ADMIN_PASSWORD`           | Initial admin password (random if omitted) | —                                  |
| `POSTGRES_PASSWORD`        | Database password                          | `blackhouse`                       |
| `DATABASE_URL`             | PostgreSQL connection string (local dev)   | —                                  |
| `BLACKHOUSE_CONTAINER_URL` | URL agent containers use to reach server   | `http://host.docker.internal:3000` |
| `DOCKER_HOST_SOCKET`       | Docker socket path                         | `/var/run/docker.sock`             |
| `PORT`                     | Host port for the app                      | `3000`                             |
| `GITHUB_CLIENT_ID`         | GitHub OAuth (optional)                    | —                                  |
| `GITHUB_CLIENT_SECRET`     | GitHub OAuth (optional)                    | —                                  |

## License

Private
