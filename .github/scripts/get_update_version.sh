#!/bin/bash

# Incrementa la version actual del package.json segun el tipo recibido.
# Formato de version: MAJOR.MINOR.PATCH.BUILD
# Usage: get_update_version.sh <major|minor|patch|build>

if [ -z "$1" ]; then
  echo "Error: El primer parametro es obligatorio (major, minor, patch, build)."
  exit 1
fi

VERSION_TYPE=$1
PACKAGE_JSON_PATH="./package.json"

VERSION=$(node -p "require('$PACKAGE_JSON_PATH').version")

increment_version() {
  local version_type=$1
  local current_version=$2
  local new_version=""

  IFS='.' read -r -a version_parts <<< "$current_version"

  case $version_type in
    major)
      ((version_parts[0]++))
      version_parts[1]=0
      version_parts[2]=0
      version_parts[3]=0
      new_version="${version_parts[0]}.${version_parts[1]}.${version_parts[2]}.${version_parts[3]}"
      ;;
    minor)
      ((version_parts[1]++))
      version_parts[2]=0
      version_parts[3]=0
      new_version="${version_parts[0]}.${version_parts[1]}.${version_parts[2]}.${version_parts[3]}"
      ;;
    patch)
      ((version_parts[2]++))
      version_parts[3]=0
      new_version="${version_parts[0]}.${version_parts[1]}.${version_parts[2]}.${version_parts[3]}"
      ;;
    build)
      ((version_parts[3]++))
      new_version="${version_parts[0]}.${version_parts[1]}.${version_parts[2]}.${version_parts[3]}"
      ;;
    *)
      echo "Error: El tipo de version debe ser 'major', 'minor', 'patch' o 'build'."
      exit 1
      ;;
  esac

  echo "$new_version"
}

NEW_VERSION=$(increment_version "$VERSION_TYPE" "$VERSION")
echo "$NEW_VERSION"
