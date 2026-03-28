ARG UBUNTU_IMAGE_VER=latest
FROM ubuntu:${UBUNTU_IMAGE_VER}

ENV DEBIAN_FRONTEND=noninteractive

# Install base tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git wget unzip jq openssh-client ca-certificates dumb-init \
    && rm -rf /var/lib/apt/lists/*

ARG NODE_MAJOR_VER=22
# Install Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR_VER:-22}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Codex CLI
RUN npm install -g @openai/codex


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
