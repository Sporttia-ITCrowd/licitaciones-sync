#!/bin/bash
set -e

# Verifica que la rama actual contenga el ultimo hotfix conocido para la base x.y.z.
# Usage: validate_hotfix_up_to_date.sh <base_version (x.y.z)>

BASE_VERSION="$1"

LATEST_HOTFIX=$(git tag -l "$BASE_VERSION.*" | grep -E "^$BASE_VERSION\.[0-9]+$" | sort -V | tail -n 1)

if [[ -z "$LATEST_HOTFIX" ]]; then
  echo "✅ No previous hotfixes. Proceeding."
  exit 0
fi

LATEST_COMMIT=$(git rev-list -n 1 "$LATEST_HOTFIX")

if git merge-base --is-ancestor "$LATEST_COMMIT" HEAD; then
  echo "✅ Branch contains latest hotfix commit: $LATEST_HOTFIX"
else
  echo "::error::❌ Branch does not contain latest hotfix ($LATEST_HOTFIX). Please rebase or merge it first."
  exit 1
fi
