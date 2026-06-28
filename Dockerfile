# Isolated development container — Claude Code runs inside, separated from the
# host OS. The workspace is bind-mounted, so edits on the host appear instantly.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_HOME=/usr/local/node
ENV PATH="${NODE_HOME}/bin:${PATH}"

# -------------------------------------------------------------------
# 1. System packages  <-- EDIT THIS LINE FOR PER-PROJECT DEPENDENCIES
# -------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates unzip git sudo \
    python3 python3-pip python3-venv build-essential \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Convenience: 'python' -> python3 if python3 is installed
RUN if command -v python3 >/dev/null && ! command -v python >/dev/null; then \
        ln -s "$(command -v python3)" /usr/local/bin/python; fi

# -------------------------------------------------------------------
# 2. Node.js (required by Claude Code) + Claude Code CLI
# -------------------------------------------------------------------
ENV NODE_VERSION=22.12.0
RUN mkdir -p ${NODE_HOME} \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    | tar -xJ -C ${NODE_HOME} --strip-components=1 \
    && npm install -g @anthropic-ai/claude-code@latest \
    && node --version && claude --version

# -------------------------------------------------------------------
# 3. Python requirements (auto-installed if the file exists)
# -------------------------------------------------------------------
# Dockerfile is a guaranteed-present source so this COPY never fails when no
# requirements file exists; the [s] globs pull in the reqs files only if present.
COPY Dockerfile requirement[s].txt py-requirement[s].txt /tmp/reqs/
RUN for f in /tmp/reqs/requirements.txt /tmp/reqs/py-requirements.txt; do \
        [ -f "$f" ] && pip3 install --break-system-packages -r "$f"; \
    done; rm -rf /tmp/reqs

# -------------------------------------------------------------------
# 4. Create a user matching the host UID/GID (clean bind-mount perms)
# -------------------------------------------------------------------
ARG HOST_UID=1000
ARG HOST_GID=1000
RUN userdel -r ubuntu 2>/dev/null || true \
    && groupadd -f -g ${HOST_GID} developer \
    && useradd -m -u ${HOST_UID} -g ${HOST_GID} -s /bin/bash developer \
    && echo "developer ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/developer

USER developer
WORKDIR /workspace

# Keep the container alive; enter-claude.sh exec's into it.
ENTRYPOINT ["tail", "-f", "/dev/null"]
