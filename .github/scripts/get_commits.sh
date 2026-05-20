#!/bin/bash

# Lista los commits desde LAST_TAG hasta HEAD filtrando por el regex Conventional Commits.
# Usage: get_commits.sh <last_tag> <commit_filter_regex>

LAST_TAG=$1
COMMIT_FILTER=$2

COMMITS=$(git log "$LAST_TAG"..HEAD --pretty=format:"%s" | grep -E "$COMMIT_FILTER")

if [ -z "$COMMITS" ]; then
  echo " "
  exit 0
fi

FORMATTED_COMMITS=$(echo "$COMMITS" | sed -E 's/^/ - /')
echo "$FORMATTED_COMMITS"
