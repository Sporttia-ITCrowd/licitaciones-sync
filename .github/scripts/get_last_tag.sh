#!/bin/bash

# Returns the latest git tag, or the version from package.json if no tags exist.
# Usage: get_last_tag.sh [default-fallback]

DEFAULT="${1:-0.0.0.0}"

# Intentar obtener el último tag
LAST_TAG=$(git describe --tags "$(git rev-list --tags --max-count=1)" 2>/dev/null)

# Si no hay tags, usar el version del package.json
if [ -z "$LAST_TAG" ]; then
  if [ -f package.json ]; then
    LAST_TAG=$(jq -r '.version // empty' package.json)
  fi
fi

# Fallback final
if [ -z "$LAST_TAG" ] || [ "$LAST_TAG" = "null" ]; then
  LAST_TAG="$DEFAULT"
fi

echo "$LAST_TAG"
