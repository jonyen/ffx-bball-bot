#!/usr/bin/env bash
#
# One-time bootstrap: deploys infra/github-oidc.yaml, which provisions the
# GitHub OIDC identity provider (if not already present in the account) plus
# an IAM role that the Deploy workflow assumes via OIDC.
#
# Run this ONCE with an AWS identity that has IAM + CloudFormation perms.
# Afterwards, paste the printed role ARN into the repo's AWS_DEPLOY_ROLE_ARN
# GitHub secret and you're done.
#
# Overrides:
#   GITHUB_ORG    default: jonyen
#   GITHUB_REPO   default: ffx-bball-bot
#   REGION        default: us-east-1
#   STACK_NAME    default: ffx-bball-bot-github-oidc
#   SUB_FILTER    default: *   (accept any ref/environment)
#                 tighten to e.g. "environment:production" for prod-only
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

GITHUB_ORG="${GITHUB_ORG:-jonyen}"
GITHUB_REPO="${GITHUB_REPO:-ffx-bball-bot}"
REGION="${REGION:-us-east-1}"
STACK_NAME="${STACK_NAME:-ffx-bball-bot-github-oidc}"
SUB_FILTER="${SUB_FILTER:-*}"

TEMPLATE="$ROOT/infra/github-oidc.yaml"

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI not found. Install it from https://aws.amazon.com/cli/ and configure credentials." >&2
  exit 1
fi

echo "Region:     $REGION"
echo "Stack:      $STACK_NAME"
echo "Repo:       $GITHUB_ORG/$GITHUB_REPO"
echo "Sub filter: $SUB_FILTER"
echo ""

# GitHub OIDC providers are account-global, so reuse one if it already exists.
EXISTING_PROVIDER_ARN="$(
  aws iam list-open-id-connect-providers \
    --query 'OpenIDConnectProviderList[?contains(Arn, `token.actions.githubusercontent.com`)].Arn | [0]' \
    --output text 2>/dev/null || echo ""
)"

if [ -n "$EXISTING_PROVIDER_ARN" ] && [ "$EXISTING_PROVIDER_ARN" != "None" ]; then
  echo "Found existing GitHub OIDC provider: $EXISTING_PROVIDER_ARN"
  echo "Reusing it instead of creating a new one."
  CREATE_PROVIDER=false
  PROVIDER_ARG="$EXISTING_PROVIDER_ARN"
else
  echo "No existing GitHub OIDC provider; the stack will create one."
  CREATE_PROVIDER=true
  PROVIDER_ARG=""
fi
echo ""

aws cloudformation deploy \
  --template-file "$TEMPLATE" \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    "GitHubOrg=$GITHUB_ORG" \
    "GitHubRepo=$GITHUB_REPO" \
    "SubjectFilter=$SUB_FILTER" \
    "CreateOidcProvider=$CREATE_PROVIDER" \
    "ExistingProviderArn=$PROVIDER_ARG"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Stack outputs:"
aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query 'Stacks[0].Outputs[*].[OutputKey,OutputValue]' \
  --output table

DEPLOY_ROLE_ARN="$(
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query 'Stacks[0].Outputs[?OutputKey==`DeployRoleArn`].OutputValue' \
    --output text
)"

echo ""
echo "✅ Deploy role ARN (copy into GitHub secret AWS_DEPLOY_ROLE_ARN):"
echo ""
echo "    $DEPLOY_ROLE_ARN"
echo ""
echo "Next: https://github.com/$GITHUB_ORG/$GITHUB_REPO/settings/secrets/actions"
