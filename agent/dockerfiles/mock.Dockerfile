# The credential-free agent image.
#
# It runs `mock-agent-tui.sh` instead of a real CLI, which means the whole
# vertical slice — create agent, start container, mention in a channel, prompt
# lands on the PTY, sidecar tails the session log, transcript renders — is
# exercisable in CI with no Anthropic/OpenAI key anywhere.
#
# It is also the only agent image that builds in seconds. The real ones are
# ~3GB (code-server, Playwright, Chromium) and take minutes; this one is
# node:24-slim plus two apt packages, so it can be built inline in a test run.
#
# Build:
#   docker build -f agent/dockerfiles/mock.Dockerfile -t blackhouse/mock-agent .
# (from the repo root — the COPY paths are repo-relative)
FROM node:24-slim

ENV DEBIAN_FRONTEND=noninteractive

# curl and jq are the skill scripts' only external dependencies; ca-certificates
# so the sidecar's fetch and the boot-time sidecar override can use HTTPS.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl jq ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Match the real images: uid 1001 `workspace`, home at /home/workspace, which
# is where lifecycle.ts mounts the per-agent state volume. The session log the
# sidecar tails lives under $HOME/.claude, so it must sit inside that mount or
# the transcript would not survive a restart.
RUN groupadd --gid 1001 workspace \
    && useradd --uid 1001 --gid 1001 --shell /bin/bash --create-home workspace

COPY agent/sidecar /opt/blackhouse/sidecar
COPY agent/entrypoint.sh /opt/blackhouse/entrypoint.sh
COPY tests/fixtures/mock-agent-tui.sh /opt/blackhouse/mock-agent-tui.sh

# Skills are normally fetched from the server at boot. Baking them in as well
# means the image works offline and a failed fetch is a no-op rather than a
# missing-tools failure the test would have to distinguish from a real bug.
COPY agent/skills/blackhouse /home/workspace/.claude/skills/blackhouse

RUN chmod +x /opt/blackhouse/entrypoint.sh /opt/blackhouse/mock-agent-tui.sh \
    /home/workspace/.claude/skills/blackhouse/*.sh \
    && mkdir -p /workspace /home/workspace/.claude/projects /home/workspace/.cache \
    && chown -R workspace:workspace /workspace /home/workspace

WORKDIR /workspace
USER workspace

# The blueprint normally supplies AGENT_COMMAND; defaulting it here lets the
# image be run standalone (`docker run -it`) to eyeball the TUI behaviour.
ENV AGENT_COMMAND="bash /opt/blackhouse/mock-agent-tui.sh"
ENV BLACKHOUSE_ADAPTER=claude-code
# Long enough that busy->idle gating is a real test rather than a race, short
# enough not to dominate an e2e budget. Override per test.
ENV MOCK_TURN_SECONDS=4

ENTRYPOINT ["/opt/blackhouse/entrypoint.sh"]
