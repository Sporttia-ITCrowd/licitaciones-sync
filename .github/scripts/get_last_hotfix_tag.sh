#!/bin/bash
set -e

# Devuelve el ultimo tag (x.y.z o x.y.z.d) accesible desde HEAD para una base x.y.z dada.
# Usage: get_last_hotfix_tag.sh <base_version (x.y.z)>

BASE_VERSION="$1"

TAG=$(git tag --merged HEAD | grep -E "^${BASE_VERSION}(\.[0-9]+)?$" | sort -V | tail -n 1)

if [[ -z "$TAG" ]]; then
  echo "::error::No tag found for base version $BASE_VERSION (expected format: x.y.z or x.y.z.d)"
  exit 1
fi

echo "$TAG"
