#!/usr/bin/env bash
# Publish one snapshot file as a parentless commit on the dedicated subway-wait-data branch (force-push).
set -euo pipefail
blob=$(git hash-object -w "$1")
tree=$(printf '100644 blob %s\tsubway-wait.json\n' "$blob" | git mktree)
commit=$(git commit-tree "$tree" -m "Subway wait snapshot")
git push --force origin "$commit:refs/heads/subway-wait-data"
