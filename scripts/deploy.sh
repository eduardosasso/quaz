#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source scripts/qa/env.sh

ID_PATTERN='^[a-z0-9][a-z0-9-]+$'
PROJECTS=()
if [ -n "${QUAZ_PROJECT_ID:-}" ]; then
  if [[ ! "$QUAZ_PROJECT_ID" =~ $ID_PATTERN ]] || [ ! -f "projects/$QUAZ_PROJECT_ID/project.json" ]; then
    echo "projects/$QUAZ_PROJECT_ID/project.json does not exist" >&2
    exit 1
  fi
  PROJECTS=("$QUAZ_PROJECT_ID")
else
  for file in projects/*/project.json; do
    [ -f "$file" ] || continue
    PROJECTS+=("$(basename "$(dirname "$file")")")
  done
fi
if [ "${#PROJECTS[@]}" -eq 0 ]; then
  echo "Add projects/<id>/project.json to deploy a controller" >&2
  exit 1
fi
for project in "${PROJECTS[@]}"; do
  if [[ ! "$project" =~ $ID_PATTERN ]]; then
    echo "Project folder name is not a valid id: $project" >&2
    exit 1
  fi
done

HOST="omarchy"
if [ -n "${MERV_JOB:-}" ]; then
  HOST="127.0.0.1"
  if [ -n "${DEPLOY_SSH_KEY:-}" ]; then
    mkdir -p "$HOME/.ssh"
    chmod 700 "$HOME/.ssh"
    if [ ! -f "$HOME/.ssh/id_ed25519" ]; then
      printf '%s' "$DEPLOY_SSH_KEY" | openssl base64 -d -A > "$HOME/.ssh/id_ed25519"
      chmod 600 "$HOME/.ssh/id_ed25519"
    fi
  fi
  if [ -n "${DEPLOY_KNOWN_HOSTS:-}" ]; then
    printf '%s\n' "$DEPLOY_KNOWN_HOSTS" >> "$HOME/.ssh/known_hosts"
    chmod 600 "$HOME/.ssh/known_hosts"
  fi
fi

TARGET="root@$HOST"
ssh -o BatchMode=yes -o ConnectTimeout=5 "$TARGET" test -S /var/run/docker.sock || {
  echo "Cannot reach $HOST over ssh, or $HOST has no Docker socket" >&2
  exit 1
}

QUAZ_DOCKER_GID="$(ssh "$TARGET" stat -c %g /var/run/docker.sock)"
export QUAZ_DOCKER_GID

if [ -z "${QUAZ_OP_SERVICE_ACCOUNT_TOKEN:-}" ] && command -v security >/dev/null 2>&1; then
  QUAZ_OP_SERVICE_ACCOUNT_TOKEN="$(security find-generic-password -a quaz -s op-quaz -w 2>/dev/null || true)"
fi
if [ -z "${QUAZ_OP_SERVICE_ACCOUNT_TOKEN:-}" ]; then
  QUAZ_OP_SERVICE_ACCOUNT_TOKEN="$(ssh "$TARGET" "cat /etc/quaz/op-service-token")"
fi
if [ -z "$QUAZ_OP_SERVICE_ACCOUNT_TOKEN" ]; then
  echo "Quaz service account token is missing" >&2
  exit 1
fi
OP_SERVICE_ACCOUNT_TOKEN="$QUAZ_OP_SERVICE_ACCOUNT_TOKEN"
export OP_SERVICE_ACCOUNT_TOKEN
unset QUAZ_OP_SERVICE_ACCOUNT_TOKEN

GITHUB_TOKEN="${QUAZ_REGISTRY_TOKEN:-}"
if [ -z "$GITHUB_TOKEN" ]; then
  GITHUB_TOKEN="$(op run --no-masking --environment "$QUAZ_ENVIRONMENT" -- printenv QUAZ_REGISTRY_TOKEN)"
fi
if [ -z "$GITHUB_TOKEN" ]; then
  echo "Add QUAZ_REGISTRY_TOKEN to the Quaz 1Password Environment" >&2
  exit 1
fi
export GITHUB_TOKEN

bun --no-env-file run lint
bun --no-env-file run check
bun --no-env-file run test
if [ "$#" -eq 0 ]; then
  set -- deploy
fi
# Kamal skips the local registry login for remote builders, so the push would use a stale saved login.
kamal registry login --skip-remote
# Every project deploys the same image, so only the first one builds and pushes it.
FIRST=1
for project in "${PROJECTS[@]}"; do
  echo "deploying quaz-$project"
  ARGS=("$@")
  if [ "$FIRST" -eq 0 ] && [ "$#" -eq 1 ] && [ "$1" = "deploy" ]; then
    ARGS=(deploy --skip-push)
  fi
  QUAZ_PROJECT_ID="$project" kamal "${ARGS[@]}"
  FIRST=0
done
