#!/usr/bin/env bash

QUAZ_ENVIRONMENT="oideewasrzxrhplsrtvqlozjna"
export QUAZ_ENVIRONMENT

if [ "${1:-}" = "--print" ]; then
  printf '%s\n' "$QUAZ_ENVIRONMENT"
fi
