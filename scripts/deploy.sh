#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

# Local runs get their secrets from .env; CI (GitHub Actions) provides them
# directly via repository secrets, so .env is optional.
if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

required=(SLACK_BOT_TOKEN SLACK_SIGNING_SECRET SLACK_BOT_USER_ID SLACK_CHANNELS FAILURE_DM_USER)
missing=()
for v in "${required[@]}"; do
  if [ -z "${!v:-}" ]; then
    missing+=("$v")
  fi
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing required env vars: ${missing[*]}" >&2
  echo "Set them in .env (local) or GitHub repo secrets (CI)." >&2
  exit 1
fi

REGION=us-east-1
SCHEDULE_NAME=ffx-bball-post-schedule

# Preserve the live ScheduleExpression across deploys so that runtime changes
# made via `/ball schedule` are not clobbered by the template default. On the
# first deploy the schedule doesn't exist yet, so we fall back to the default.
GIT_SHA="${GITHUB_SHA:-$(git -C "$ROOT" rev-parse HEAD)}"
GITHUB_RUN_NUMBER="${GITHUB_RUN_NUMBER:-local}"

PARAMS="SlackBotToken=$SLACK_BOT_TOKEN SlackSigningSecret=$SLACK_SIGNING_SECRET SlackBotUserId=$SLACK_BOT_USER_ID SlackChannels=$SLACK_CHANNELS FailureDmUser=$FAILURE_DM_USER GitSha=$GIT_SHA GithubRunNumber=$GITHUB_RUN_NUMBER"

SCHED_ERR="$(mktemp)"
trap 'rm -f "$SCHED_ERR"' EXIT

set +e
CURRENT_EXPR=$(aws scheduler get-schedule \
  --name "$SCHEDULE_NAME" \
  --region "$REGION" \
  --query 'ScheduleExpression' \
  --output text 2>"$SCHED_ERR")
GET_RC=$?
set -e

if [ $GET_RC -eq 0 ] && [ -n "$CURRENT_EXPR" ] && [ "$CURRENT_EXPR" != "None" ]; then
  echo "Preserving live schedule expression: $CURRENT_EXPR"
  PARAMS="$PARAMS ScheduleExpression=\"$CURRENT_EXPR\""
elif grep -q "ResourceNotFoundException" "$SCHED_ERR"; then
  echo "No existing schedule; using template default on first deploy."
else
  echo "Failed to read current schedule ($SCHEDULE_NAME in $REGION):" >&2
  cat "$SCHED_ERR" >&2
  echo "Aborting to avoid overwriting a live schedule. Fix credentials/permissions or delete the schedule to proceed." >&2
  exit 1
fi

cd "$ROOT/infra"

sam build

sam deploy \
  --stack-name ffx-bball-bot \
  --region "$REGION" \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --no-confirm-changeset \
  --no-fail-on-empty-changeset \
  --parameter-overrides "$PARAMS"
