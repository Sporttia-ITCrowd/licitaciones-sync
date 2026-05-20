#!/bin/bash
set -e

# Obtener el ultimo tag de esta rama que tenga formato x.y.z.d
CURRENT_TAG=$(git describe --tags --abbrev=0 --match "[0-9]*.[0-9]*.[0-9]*.[0-9]*" HEAD)

if [[ -z "$CURRENT_TAG" ]]; then
  echo "::error::No x.y.z.d tag found on this branch."
  exit 1
fi

# Extraer solo x.y.z como base
BASE_TAG=$(echo "$CURRENT_TAG" | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+')

if [[ -z "$BASE_TAG" ]]; then
  echo "::error::Failed to extract base tag from $CURRENT_TAG"
  exit 1
fi

echo "$BASE_TAG"
