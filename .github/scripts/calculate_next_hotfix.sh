#!/bin/bash
set -e

# Calcula el siguiente tag de hotfix incrementando el ultimo componente (BUILD).
# Usage: calculate_next_hotfix.sh <base_version (x.y.z)>

BASE_VERSION="$1"

EXISTING=$(git tag -l "$BASE_VERSION.*" | grep -E "^$BASE_VERSION\.[0-9]+$" | sed "s/$BASE_VERSION\.//" | sort -n)
NEXT=1
for t in $EXISTING; do
  if [[ $t -ge $NEXT ]]; then
    NEXT=$((t + 1))
  fi
done

echo "$BASE_VERSION.$NEXT"
