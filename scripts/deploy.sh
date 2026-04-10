#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

if [ ! -f "$ROOT/.env" ]; then
  echo "No .env file at $ROOT/.env" >&2
  echo "Copy .env.example to .env and fill it in." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source "$ROOT/.env"
set +a

required=(SLACK_BOT_TOKEN SLACK_SIGNING_SECRET SLACK_BOT_USER_ID OPENWEATHERMAP_API_KEY SLACK_CHANNEL)
missing=()
for v in "${required[@]}"; do
  if [ -z "${!v:-}" ]; then
    missing+=("$v")
  fi
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing required env vars in .env: ${missing[*]}" >&2
  exit 1
fi

cd "$ROOT/infra"

sam build

sam deploy \
  --stack-name ffx-bball-bot \
  --region us-east-1 \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --no-confirm-changeset \
  --no-fail-on-empty-changeset \
  --parameter-overrides "SlackBotToken=$SLACK_BOT_TOKEN SlackSigningSecret=$SLACK_SIGNING_SECRET SlackBotUserId=$SLACK_BOT_USER_ID OpenWeatherMapApiKey=$OPENWEATHERMAP_API_KEY SlackChannel=$SLACK_CHANNEL"
