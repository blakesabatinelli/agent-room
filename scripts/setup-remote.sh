#!/bin/sh
# K1: create the private remote and protect main. Run once, from the repo root, signed in to GitHub CLI:
#   gh auth login
#   ./scripts/setup-remote.sh [owner/name]
# Default name is <your GitHub user>/agent-room.
# Note: branch protection on a *private* repo needs GitHub Pro (personal) or Team (org).
set -e
cd "$(dirname "$0")/.."

REPO="${1:-$(gh api user --jq .login)/agent-room}"

if ! git remote get-url origin >/dev/null 2>&1; then
  gh repo create "$REPO" --private --source=. --remote=origin --description "Agent Room: one room, every agent"
fi
git push -u origin main

# Require the CI job to pass and a PR to merge; no force pushes or deletion of main.
gh api -X PUT "repos/$REPO/branches/main/protection" \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["check"] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
echo "Remote ready: https://github.com/$REPO (main is protected; CI must pass)."
