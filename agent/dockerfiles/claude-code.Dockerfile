ARG UBUNTU_IMAGE_VER=24.04
FROM ubuntu:${UBUNTU_IMAGE_VER}

ENV DEBIAN_FRONTEND=noninteractive

# Install base tools in a single layer
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git wget unzip jq vim openssh-client ca-certificates dumb-init \
    locales build-essential python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && sed -i '/en_US.UTF-8/s/^# //' /etc/locale.gen && locale-gen

ARG NODE_MAJOR_VER=24
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR_VER:-24}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# --- Shared Blackhouse v-next additions ---------------------------------------
# Identical block across all three agent images so the layer cache is reused.

# code-server: browser IDE bound to 127.0.0.1:8443 inside the container,
# proxied by the Blackhouse server to the IDE tab in the SPA.
RUN curl -fsSL https://code-server.dev/install.sh | sh

# Playwright + Chromium for the in-container browser service. Browsers live
# under /opt/blackhouse/ms-playwright so the workspace user can read them
# without owning a per-user playwright cache.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/blackhouse/ms-playwright
COPY agent/browser-service /opt/blackhouse/browser-service
RUN cd /opt/blackhouse/browser-service \
    && npm install --omit=dev \
    && npx playwright install --with-deps chromium \
    && chmod -R a+rX /opt/blackhouse/browser-service /opt/blackhouse/ms-playwright

# $BROWSER shim — tools that respect $BROWSER/xdg-open route into the
# embedded browser tab via this script.
COPY agent/skills/blackhouse/browser-shim.sh /opt/blackhouse/browser-shim.sh
RUN chmod +x /opt/blackhouse/browser-shim.sh
ENV BROWSER=/opt/blackhouse/browser-shim.sh

# Default code-server user settings (dark theme to match the SPA). Seeded
# into $HOME/.local/share/code-server/User/settings.json by entrypoint.sh
# on first launch, with `cp -n` so a user-supplied override wins.
COPY agent/code-server-config /opt/blackhouse/code-server-config

# The event sidecar. Zero dependencies (node builtins + global fetch), so it is
# a plain COPY with no install step. entrypoint.sh prefers a copy fetched from
# the server at boot over this one — rebuilding a ~3GB image to change one line
# of an adapter is not an iteration loop anybody can live with.
COPY agent/sidecar /opt/blackhouse/sidecar

# --- Agent-specific install ---------------------------------------------------

# Create non-root workspace user (before installing agent so it goes to user home)
RUN groupadd --gid 1001 workspace \
    && useradd --uid 1001 --gid 1001 --shell /bin/bash --create-home workspace

# Install Claude Code from npm.
#
# This used to be `curl -fsSL https://claude.ai/install.sh | bash`, which is the
# documented installer and fails from a datacenter IP: claude.ai answers 403
# with a Cloudflare bot challenge. Worse, it failed *silently* — in a pipeline
# the exit status is bash's, and bash handed an empty stdin exits 0, so the
# layer succeeded and the image shipped with no CLI. The agent then started,
# ran `exec claude`, and died with `claude: not found`.
#
# npm is the same distribution and needs no interactive challenge. Installed as
# root into the global prefix (`/usr/local/bin`), already on every user's PATH,
# rather than into the workspace user's home.
RUN npm install -g @anthropic-ai/claude-code \
    && command -v claude

# Pre-create volume mount directories as workspace user so Docker
# preserves ownership when mounting named volumes (avoids root:root)
RUN mkdir -p /workspace /home/workspace/.claude /home/workspace/.config/claude-auth \
    && chown -R workspace:workspace /workspace /home/workspace/.claude /home/workspace/.config
WORKDIR /workspace

# Copy entrypoint
COPY agent/entrypoint.sh /opt/blackhouse/entrypoint.sh
RUN chmod +x /opt/blackhouse/entrypoint.sh

USER workspace
ENV PATH="/home/workspace/.local/bin:${PATH}"

ENTRYPOINT ["dumb-init", "--", "/opt/blackhouse/entrypoint.sh"]
CMD ["sleep", "infinity"]
