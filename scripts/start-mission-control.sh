#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
PORT=${PORT:-3000}
DIST_DIR=${HERMES_NEXT_DIST_DIR:-.next}

case "$PORT" in
  ''|*[!0-9]*)
    printf '%s\n' "PORT must be an integer from 1 to 65535." >&2
    exit 2
    ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  printf '%s\n' "PORT must be an integer from 1 to 65535." >&2
  exit 2
fi

case "$DIST_DIR" in
  /*) BUILD_DIR=$DIST_DIR ;;
  *) BUILD_DIR=$PROJECT_ROOT/$DIST_DIR ;;
esac

if ! command -v npm >/dev/null 2>&1; then
  printf '%s\n' "npm was not found. Install Node.js 22 or newer, then run npm run setup." >&2
  exit 127
fi
if [ ! -s "$BUILD_DIR/BUILD_ID" ]; then
  printf '%s\n' "Production build is missing. Run npm run setup from $PROJECT_ROOT." >&2
  exit 1
fi

cd "$PROJECT_ROOT"
export NODE_ENV=production
export PORT
export HOSTNAME=127.0.0.1
exec npm run start -- --port "$PORT"
