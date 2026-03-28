FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Install base tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git wget unzip jq openssh-client ca-certificates dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Gemini CLI
RUN npm install -g @google/gemini-cli

# Install Skills CLI (cross-agent skill support)
RUN npm install -g @anthropic-ai/skills

# Create non-root workspace user
RUN groupadd --gid 1001 workspace \
    && useradd --uid 1001 --gid 1001 --shell /bin/bash --create-home workspace

# Create workspace directory
RUN mkdir -p /workspace && chown workspace:workspace /workspace
WORKDIR /workspace

# Copy entrypoint
COPY scripts/session-entrypoint.sh /opt/blackhouse/entrypoint.sh
RUN chmod +x /opt/blackhouse/entrypoint.sh

USER workspace

ENTRYPOINT ["dumb-init", "--", "/opt/blackhouse/entrypoint.sh"]
CMD ["sleep", "infinity"]
