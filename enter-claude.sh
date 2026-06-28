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
