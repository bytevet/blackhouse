ARG UBUNTU_IMAGE_VER=latest
FROM ubuntu:${UBUNTU_IMAGE_VER}

ENV DEBIAN_FRONTEND=noninteractive

# Install base tools in a single layer
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git wget unzip jq vim openssh-client ca-certificates dumb-init \
    locales build-essential python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

ARG NODE_MAJOR_VER=22
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR_VER:-22}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Codex CLI globally
RUN npm install -g @openai/codex

# Create non-root workspace user
RUN groupadd --gid 1001 workspace \
    && useradd --uid 1001 --gid 1001 --shell /bin/bash --create-home workspace

# Create workspace directory
RUN mkdir -p /workspace && chown workspace:workspace /workspace
WORKDIR /workspace

# Copy entrypoint
COPY agent/entrypoint.sh /opt/blackhouse/entrypoint.sh
RUN chmod +x /opt/blackhouse/entrypoint.sh

USER workspace

ENTRYPOINT ["dumb-init", "--", "/opt/blackhouse/entrypoint.sh"]
CMD ["sleep", "infinity"]
