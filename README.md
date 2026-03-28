# Blackhouse

A coding agent management platform for spawning and managing Docker-containerized coding agents (Claude Code, Gemini, Codex) with real-time terminal access, file explorers, and result viewers.

## Features

- **Agent Presets** — Claude Code, Gemini, Codex with pre-configured Dockerfiles, commands, and credential volumes
- **Interactive Terminal** — xterm.js-based terminal with binary WebSocket protocol, multi-tab sync, and scrollback replay
- **Session Management** — Create, stop, restart, destroy coding sessions with Docker containers
- **File Explorer** — Browse files, view content, and see git diffs inside running containers
- **Template System** — Reusable prompt templates with system prompts and git requirements
- **Role-Based Access** — Admin and user roles with per-route guards
- **Dark Mode** — Theme switcher (light/dark/system) with persistence
- **Responsive** — Works on desktop and mobile

## Tech Stack

- [TanStack Start](https://tanstack.com/start) — Full-stack SSR framework
- [TanStack Form](https://tanstack.com/form) — Form state management with Zod validation
- [shadcn/ui](https://ui.shadcn.com) — UI components (base-mira style)
- [PostgreSQL](https://www.postgresql.org/) + [Drizzle ORM](https://orm.drizzle.team/)
- [Better Auth](https://www.better-auth.com/) — Authentication
- [dockerode](https://github.com/apocas/dockerode) — Docker API client
- [xterm.js](https://xtermjs.org/) — Terminal emulator

## Getting Started

### Prerequisites

- Node.js 22+
- Docker
- PostgreSQL (or use docker-compose)

### Setup

```bash
# Install dependencies
npm install

# Start PostgreSQL
docker-compose up -d db

# Push database schema
npm run db:push

# Seed default data (admin user + agent presets)
npm run db:seed

# Start dev server
npm run dev
```

The app is available at [http://localhost:3000](http://localhost:3000).

Default admin credentials: `admin` / `admin123`

### Build Agent Images

Before creating sessions, build the Docker images for each agent preset:

1. Go to **Settings > Coding Agents**
2. Click the **Build** button for each agent
3. Wait for the build to complete (watch the live build log)

### Create a Session

1. Go to **Dashboard**
2. Click **New Session**
3. Select a built agent, optionally choose a template and git repo
4. The session starts automatically — terminal connects to the agent

## Docker Deployment

```bash
# Build and start everything
docker-compose up -d

# Or build just the app
docker build -t blackhouse .
```

### Environment Variables

```env
DATABASE_URL=postgresql://blackhouse:blackhouse@localhost:5432/blackhouse
BETTER_AUTH_SECRET=your-secret-key
BETTER_AUTH_URL=http://localhost:3000
GITHUB_CLIENT_ID=your-github-client-id        # Optional
GITHUB_CLIENT_SECRET=your-github-client-secret  # Optional
```

## Development

```bash
npm run dev          # Start dev server
npm test             # Run unit tests
npm run format       # Format code
npx playwright test  # Run e2e tests
npm run db:studio    # Open Drizzle Studio
```

## Project Structure

```
src/
├── components/        # UI components (terminal, file explorer, header)
│   └── ui/            # shadcn/ui components (managed, do not edit)
├── db/                # Database schema and connection
├── lib/               # Shared utilities and configs
├── routes/            # TanStack file-based routes
│   ├── _authed/       # Protected routes (dashboard, sessions, settings, templates)
│   └── api/           # API routes
└── server/            # Server functions with middleware
dockerfiles/           # Per-agent preset Dockerfiles (Claude Code, Gemini, Codex)
server/routes/         # Nitro server routes (WebSocket terminal)
tests/                 # Unit + E2E tests
```

## License

Private
