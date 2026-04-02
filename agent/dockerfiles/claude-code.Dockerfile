ARG UBUNTU_IMAGE_VER=latest
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

# Create non-root workspace user (before installing agent so it goes to user home)
RUN groupadd --gid 1001 workspace \
    && useradd --uid 1001 --gid 1001 --shell /bin/bash --create-home workspace

# Install Claude Code as workspace user via official installer
USER workspace
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/workspace/.local/bin:${PATH}"
USER root

# Create workspace directory
RUN mkdir -p /workspace && chown workspace:workspace /workspace
WORKDIR /workspace

# Copy entrypoint
COPY agent/entrypoint.sh /opt/blackhouse/entrypoint.sh
RUN chmod +x /opt/blackhouse/entrypoint.sh

USER workspace
ENV PATH="/home/workspace/.local/bin:${PATH}"

ENTRYPOINT ["dumb-init", "--", "/opt/blackhouse/entrypoint.sh"]
CMD ["sleep", "infinity"]
