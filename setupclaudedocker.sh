#!/usr/bin/env bash
# Re-exec under bash if started with sh/dash (which lacks `set -o pipefail`,
# `[[ ]]`, etc.). Guards against `sh setupclaudedocker.sh`.
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi
# =============================================================================
# setup-claude-docker.sh
#
# Bootstrap an isolated Docker dev environment + Claude Code for ANY project.
# Run this once inside a project folder; it writes four files:
#
#     Dockerfile            container image (edit the EXTRA_APT line per project)
#     docker-compose.yml    service definition (per-folder container/image)
#     enter-claude.sh       drop into the container and launch Claude Code
#     .dockerignore         keep the build context small
#
# Each project folder gets its OWN container, image and compose project, keyed
# to the folder's absolute path — so two clones in two folders never share (and
# silently overwrite) each other's container.
#
# Usage:
#     cd /path/to/your/project
#     bash setup-claude-docker.sh           # generate files (won't clobber)
#     bash setup-claude-docker.sh --force   # overwrite existing files
#     ./enter-claude.sh                      # build + enter the container
#
# Per-project dependencies:
#     - Edit the "System packages" block in the generated Dockerfile, OR
#     - export EXTRA_APT="..."   before running this script to seed it, OR
#     - drop a requirements.txt (or py-requirements.txt) in the folder and it
#       is pip-installed automatically.
#
# Env overrides (all optional):
#     BASE_IMAGE     default ubuntu:24.04
#     EXTRA_APT      default "python3 python3-pip python3-venv build-essential"
#     NODE_VERSION   default 22.12.0   (Node is required by Claude Code)
#     CLAUDE_VERSION default latest
# =============================================================================
set -euo pipefail

FORCE=0
[[ "${1:-}" == "--force" || "${1:-}" == "-f" ]] && FORCE=1

BASE_IMAGE="${BASE_IMAGE:-ubuntu:24.04}"
EXTRA_APT="${EXTRA_APT:-python3 python3-pip python3-venv build-essential}"
NODE_VERSION="${NODE_VERSION:-22.12.0}"
CLAUDE_VERSION="${CLAUDE_VERSION:-latest}"

write() { # write <path> ; reads file body from stdin
    local path="$1"
    if [[ -e "$path" && $FORCE -ne 1 ]]; then
        printf '\033[33mskip\033[0m   %s (exists; use --force to overwrite)\n' "$path"
        cat >/dev/null
        return
    fi
    cat > "$path"
    printf '\033[32mwrote\033[0m  %s\n' "$path"
}

# ---------------------------------------------------------------------------
# Dockerfile
# ---------------------------------------------------------------------------
write Dockerfile <<EOF
# Isolated development container — Claude Code runs inside, separated from the
# host OS. The workspace is bind-mounted, so edits on the host appear instantly.
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_HOME=/usr/local/node
ENV PATH="\${NODE_HOME}/bin:\${PATH}"

# -------------------------------------------------------------------
# 1. System packages  <-- EDIT THIS LINE FOR PER-PROJECT DEPENDENCIES
# -------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \\
    curl ca-certificates unzip git sudo \\
    ${EXTRA_APT} \\
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Convenience: 'python' -> python3 if python3 is installed
RUN if command -v python3 >/dev/null && ! command -v python >/dev/null; then \\
        ln -s "\$(command -v python3)" /usr/local/bin/python; fi

# -------------------------------------------------------------------
# 2. Node.js (required by Claude Code) + Claude Code CLI
# -------------------------------------------------------------------
ENV NODE_VERSION=${NODE_VERSION}
RUN mkdir -p \${NODE_HOME} \\
    && curl -fsSL "https://nodejs.org/dist/v\${NODE_VERSION}/node-v\${NODE_VERSION}-linux-x64.tar.xz" \\
    | tar -xJ -C \${NODE_HOME} --strip-components=1 \\
    && npm install -g @anthropic-ai/claude-code@${CLAUDE_VERSION} \\
    && node --version && claude --version

# -------------------------------------------------------------------
# 3. Python requirements (auto-installed if the file exists)
# -------------------------------------------------------------------
# Dockerfile is a guaranteed-present source so this COPY never fails when no
# requirements file exists; the [s] globs pull in the reqs files only if present.
COPY Dockerfile requirement[s].txt py-requirement[s].txt /tmp/reqs/
RUN for f in /tmp/reqs/requirements.txt /tmp/reqs/py-requirements.txt; do \\
        [ -f "\$f" ] && pip3 install --break-system-packages -r "\$f"; \\
    done; rm -rf /tmp/reqs

# -------------------------------------------------------------------
# 4. Create a user matching the host UID/GID (clean bind-mount perms)
# -------------------------------------------------------------------
ARG HOST_UID=1000
ARG HOST_GID=1000
RUN userdel -r ubuntu 2>/dev/null || true \\
    && groupadd -f -g \${HOST_GID} developer \\
    && useradd -m -u \${HOST_UID} -g \${HOST_GID} -s /bin/bash developer \\
    && echo "developer ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/developer

USER developer
WORKDIR /workspace

# Keep the container alive; enter-claude.sh exec's into it.
ENTRYPOINT ["tail", "-f", "/dev/null"]
EOF

# ---------------------------------------------------------------------------
# docker-compose.yml
# ---------------------------------------------------------------------------
write docker-compose.yml <<'EOF'
# Isolated Claude Code environment.
# The container name / image / project are made unique per workspace FOLDER by
# enter-claude.sh, so different clones never collide. Falls back to generic
# names for a plain `docker compose up`.
services:
  workspace:
    build:
      context: .
      args:
        HOST_UID: ${HOST_UID:-1000}
        HOST_GID: ${HOST_GID:-1000}
    image: ${COMPOSE_IMAGE:-claude-workspace:dev}
    container_name: ${CONTAINER_NAME:-claude-workspace}
    stdin_open: true
    tty: true
    volumes:
      - .:/workspace:cached       # real-time bidirectional sync with the host
    environment:
      - TERM=${TERM:-xterm-256color}
      - HOME=/home/developer
    # For GPU access, uncomment:
    # deploy:
    #   resources:
    #     reservations:
    #       devices:
    #         - driver: nvidia
    #           count: 1
    #           capabilities: [gpu]
    restart: unless-stopped
EOF

# ---------------------------------------------------------------------------
# enter-claude.sh
# ---------------------------------------------------------------------------
write enter-claude.sh <<'EOF'
#!/usr/bin/env bash
# Build/start an isolated container for THIS folder and run Claude Code in it.
# Container identity is derived from this folder's absolute path, so a second
# clone in another folder gets its OWN container (never re-enters this one).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

WORKSPACE_HASH="$(printf '%s' "$SCRIPT_DIR" | sha1sum | cut -c1-8)"
WORKSPACE_SLUG="$(basename "$SCRIPT_DIR" | tr -c 'a-zA-Z0-9_-' '-' | sed 's/-\+/-/g;s/^-//;s/-$//')"
export CONTAINER_NAME="${CONTAINER_NAME:-claude-${WORKSPACE_SLUG}-${WORKSPACE_HASH}}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-cw-${WORKSPACE_HASH}}"
export COMPOSE_IMAGE="${COMPOSE_IMAGE:-claude-${WORKSPACE_HASH}:dev}"
export HOST_UID="${HOST_UID:-$(id -u)}"
export HOST_GID="${HOST_GID:-$(id -g)}"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }

ws_source() { # host path bind-mounted at /workspace in container $1
    docker inspect "$1" --format \
        '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}' 2>/dev/null
}

command -v docker &>/dev/null || { red "docker is not installed or not in PATH."; exit 1; }
cd "$SCRIPT_DIR"

# If a same-named container is mounted elsewhere, recreate it for this folder.
if docker inspect "$CONTAINER_NAME" &>/dev/null; then
    src="$(ws_source "$CONTAINER_NAME")"
    if [[ -n "$src" && "$src" != "$SCRIPT_DIR" ]]; then
        yellow "Container '$CONTAINER_NAME' mounted to $src, not $SCRIPT_DIR — recreating."
        docker rm -f "$CONTAINER_NAME" >/dev/null
    fi
fi

if ! docker inspect "$CONTAINER_NAME" --format '{{.State.Running}}' &>/dev/null; then
    if docker inspect "$CONTAINER_NAME" --format '{{.State.Status}}' &>/dev/null; then
        yellow "Starting stopped container '$CONTAINER_NAME'..."; docker start "$CONTAINER_NAME" >/dev/null; sleep 1
    else
        yellow "Building + starting container for this folder..."; docker compose up -d --build; sleep 2
    fi
fi

src="$(ws_source "$CONTAINER_NAME")"
if [[ -n "$src" && "$src" != "$SCRIPT_DIR" ]]; then
    red "Refusing to enter: '$CONTAINER_NAME' is mounted to $src, not $SCRIPT_DIR"
    red "Run: docker rm -f $CONTAINER_NAME   then re-run this script."; exit 1
fi

green "Entering '$CONTAINER_NAME'  (/workspace -> $SCRIPT_DIR)"
exec docker exec -it "$CONTAINER_NAME" \
    bash -c 'exec claude --dangerously-skip-permissions "$@"' -- "$@"
EOF
chmod +x enter-claude.sh 2>/dev/null || true

# ---------------------------------------------------------------------------
# .dockerignore  (don't clobber an existing one)
# ---------------------------------------------------------------------------
write .dockerignore <<'EOF'
.git/
node_modules/
__pycache__/
*.py[cod]
.venv/
venv/
.vscode/
.idea/
*.swp
*~
.DS_Store
Thumbs.db
*.log
EOF

printf '\n\033[32mDone.\033[0m Next:\n'
printf '  1. (optional) edit the "System packages" line in ./Dockerfile\n'
printf '  2. ./enter-claude.sh\n'