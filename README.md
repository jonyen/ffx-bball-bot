# ffx-bball-bot

Slack bot that posts a basketball roll-call to a channel twice a week (Tue/Thu 8am EST) and tracks RSVPs via emoji reactions. Weather for Nottoway Park is baked into the initial post.

Design doc: `docs/superpowers/specs/2026-04-09-basketball-slack-bot-design.md`

## Architecture

Three AWS Lambda functions:

- **postMessage** — EventBridge Scheduler cron triggers it Tue/Thu 8:00 AM America/New_York (DST-aware). Fetches weather, formats, posts the default `🏀 today?` roll-call.
- **reactionHandler** — API Gateway HTTP API route `POST /slack/events`. Verifies signature, re-fetches reaction state, rewrites the message via `chat.update`. Preserves any custom header (e.g. from `/ball`).
- **slashCommand** — API Gateway HTTP API route `POST /slack/commands`. Handles `/ball <message>` — posts an ad-hoc roll-call to the channel where the command was invoked, with the user's custom header text and a mention attributing the caller. The reactionHandler handles reactions on these the same way it does scheduled posts.

On any unrecoverable send-time failure in any Lambda, a DM is sent to `U0000000000` via `chat.postMessage`. This is application-level error notification — it only fires inside the Lambdas, not on infra errors.

## /ball slash command

```
/ball :basketball: tonight at 7pm, outdoor courts
```

Renders as:

```
🏀 tonight at 7pm, outdoor courts (alice)

──────────────
☀️ Nottoway Park — 72°F, Clear sky
```

- The bot posts the user's text verbatim — no auto-prepended emoji. Type `:basketball:` (or any other emoji) yourself if you want one in the header.
- `/ball` posts only to the channel where the command was invoked; the multi-channel `SLACK_CHANNELS` fanout only applies to the scheduled post.
- Empty invocations (`/ball` with no text) respond with an ephemeral usage hint.
- Weather fetch uses a 2-second timeout (vs. 8s for the scheduled post) to stay inside Slack's 3-second slash command deadline; on timeout the message posts without the weather line.
- Reactions on `/ball` posts work identically to scheduled posts — the existing header is preserved on rewrite.

To fix a typo or change the time after posting, run:

```
/ball edit <new message>
```

This rewrites the most recent bball message in the current channel with the new header text, preserving the current reactions (In/Maybe/Out) and refreshing the weather for "now". It only touches the channel where the command is run — other channels in `SLACK_CHANNELS` are left alone.

### Viewing and updating the scheduled post

```
/ball schedule
```

Shows the current EventBridge schedule that drives the twice-weekly post (expression, timezone, enabled state) as an ephemeral message.

Update it with natural language, like Slack's `/remind`:

```
/ball schedule every Tue, Thu at 8am
/ball schedule every weekday at 9:30am
/ball schedule every day at noon
/ball schedule every mon,wed,fri at 7am
/ball schedule every Friday at 5pm
```

The handler parses day(s) + time and translates to a cron expression in the schedule's existing timezone (`America/New_York`). The response echoes both the resulting cron and an `Interpreted as:` line so you can confirm the parse before it takes effect. Unambiguous 12-hour times (`am`/`pm`, or `noon`/`midnight`) and 24-hour `HH:MM` forms are both accepted; plain "8" without `am`/`pm` or a colon is rejected as ambiguous.

**`every` is required for recurrence.** Bare forms like `/ball schedule Tuesday at 8am` are rejected with a suggested fix (`every Tuesday at 8am`). One-shot scheduling isn't supported — there's a single shared EventBridge schedule that gets mutated in place, so a one-shot fire would leave it in a terminal state and the next scheduled post would stop happening. Plural day names (`tuesdays`, `mondays`), the group aliases (`weekday`/`weekdays`/`weekend`/`weekends`), and `daily`/`everyday` all count as recurrence markers and are accepted without an explicit `every`.

Raw cron and rate expressions still work for power users:

```
/ball schedule 0 7 ? * MON,WED,FRI *        # bare cron — auto-wrapped
/ball schedule cron(30 17 ? * FRI *)        # already-wrapped cron
/ball schedule rate(1 day)                  # rate expressions also accepted
```

The command calls `scheduler:GetSchedule` and `scheduler:UpdateSchedule` on the stack's `ffx-bball-post-schedule`, preserving the target, role, flexible-window config, and timezone. Only the expression changes.

**Persistence across deploys.** `scripts/deploy.sh` reads the current live `ScheduleExpression` from EventBridge Scheduler before each deploy and passes it as `--parameter-overrides ScheduleExpression=...`, so runtime changes made via `/ball schedule` survive `sam deploy`. On the very first deploy (when the schedule doesn't exist yet) the template default `cron(0 8 ? * TUE,THU *)` is used. If you run `sam deploy` manually without the wrapper script, pass `--parameter-overrides ScheduleExpression="<cron>"` yourself or the template default will overwrite the live value.

## Reactions

| Emoji | Category |
|---|---|
| `basketball`, `+1`, `white_check_mark` | In |
| `x`, `-1`, `nope` | Out |
| anything else | Maybe |

If a user lands in multiple categories, In > Out > Maybe.

## Layout

```
src/
  postMessage/       # cron-triggered Lambda
    handler.js
    weather.js
  reactionHandler/   # reaction webhook Lambda
    handler.js
    verifySignature.js
    categorize.js
  slashCommand/      # /ball slash command Lambda
    handler.js
  shared/
    slack.js          # Slack API client + notifyFailure
    formatMessage.js  # shared message formatter (+ parseHeader, parseWeatherLine)
    scheduler.js      # EventBridge Scheduler client for /ball schedule
    scheduleParser.js # natural-language → cron parser for /ball schedule
test/                # vitest
infra/
  template.yaml      # AWS SAM — main app stack
  github-oidc.yaml   # bootstrap stack — GitHub OIDC provider + deploy role
```

## Development

```bash
npm install
npm test            # run the full suite
npm run test:watch  # watch mode
```

## Configuration

Copy `.env.example` to `.env` and fill in:

- `SLACK_BOT_TOKEN` — xoxb-... with scopes `chat:write`, `reactions:read`, `channels:history`, `groups:history`, `users:read`
- `SLACK_SIGNING_SECRET` — from the Slack app's Basic Information
- `SLACK_BOT_USER_ID` — the bot's own Slack user ID (used to filter reactions on our own messages)
- `SLACK_CHANNELS` — comma-separated list of target channel IDs (default: `C0123456789`). The bot must be invited to each channel.

Weather is fetched from the US National Weather Service (weather.gov) API — no key required.

## Deploy

```bash
cd infra
sam build
sam deploy --guided
```

SAM will prompt for all parameters. Save answers with `--save-config` on the first deploy, then subsequent deploys are just `sam deploy`.

After the first deploy:

1. Take the `SlackEventsUrl` output and paste it into the Slack app's **Event Subscriptions** → Request URL. Subscribe to bot events: `reaction_added`, `reaction_removed`.
2. Take the `SlackCommandsUrl` output, create a **Slash Command** in the Slack app config (`/ball`), and paste the URL as its Request URL. Short description: "Post an ad-hoc basketball roll-call". Usage hint: `<message>`.
3. Invite the bot to the target channel.

Required bot token scopes: `chat:write`, `reactions:read`, `channels:history`, `groups:history`, `commands`, `users:read`.

The slash command Lambda also needs IAM permissions to manage the schedule (`scheduler:GetSchedule`, `scheduler:UpdateSchedule`, `iam:PassRole` on the scheduler role) — these are attached automatically by the SAM template.

## Deploy from GitHub Actions

The `.github/workflows/deploy.yml` workflow runs `scripts/deploy.sh` on:

- **push to `main`** — when any of `src/**`, `infra/**`, `scripts/deploy.sh`, `package*.json`, or the workflow file itself changes.
- **manual `workflow_dispatch`** — from the Actions tab in GitHub.

The workflow installs dependencies, runs `npm test` as a **pre-deploy gate** (broken suite → no deploy), installs the SAM CLI, authenticates to AWS via OIDC, and finally calls `scripts/deploy.sh` — so the live-schedule preservation described above is honored in CI too.

Concurrency is pinned to the stack name (`deploy-ffx-bball-bot`, `cancel-in-progress: false`) so two deploys can't race CloudFormation.

### One-time AWS setup (OIDC)

The workflow authenticates via GitHub OIDC — no long-lived AWS access keys. Everything you need is provisioned by a bootstrap CloudFormation stack (`infra/github-oidc.yaml`) plus a wrapper script that runs it for you:

```bash
bash scripts/bootstrap-oidc.sh
```

The script:

1. Checks for an existing GitHub OIDC identity provider in your account (they're account-global, so if you already have one for another repo, it's reused).
2. Deploys the `ffx-bball-bot-github-oidc` CFN stack, which creates the deploy IAM role with a trust policy scoped to `repo:jonyen/ffx-bball-bot:*` — nobody else's workflow can assume it.
3. Prints the role ARN you paste into the `AWS_DEPLOY_ROLE_ARN` GitHub secret.

Overrides (env vars):

| Var | Default | Notes |
|---|---|---|
| `GITHUB_ORG` | `jonyen` | Override if you forked the repo. |
| `GITHUB_REPO` | `ffx-bball-bot` | |
| `REGION` | `us-east-1` | |
| `STACK_NAME` | `ffx-bball-bot-github-oidc` | |
| `SUB_FILTER` | `*` | Set to `environment:production` to only allow runs that target the production environment, or `ref:refs/heads/main` to lock to `main`. |

Run it with an AWS identity that has IAM + CloudFormation permissions (your own admin user works for a one-shot bootstrap). The stack attaches `AdministratorAccess` to the deploy role by default — pragmatic for a personal project because SAM needs broad perms to create IAM roles, Lambda functions, API Gateway, the Scheduler resource, and CFN stacks. You can tighten to a custom managed policy later by editing `infra/github-oidc.yaml`.

If you'd rather set this up by hand instead of running the script, the template at `infra/github-oidc.yaml` documents exactly what it creates and you can deploy it directly with `aws cloudformation deploy`.

### GitHub secrets

In the repo → **Settings → Secrets and variables → Actions → New repository secret**, create:

| Secret | Value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | the IAM role ARN from step 3 above |
| `SLACK_BOT_TOKEN` | `xoxb-…` |
| `SLACK_SIGNING_SECRET` | signing secret |
| `SLACK_BOT_USER_ID` | the bot's user ID |

And one repository **variable** (Settings → Secrets and variables → Actions → Variables tab):

| Variable | Value |
|---|---|
| `SLACK_CHANNELS` | comma-separated channel IDs |

> ⚠️ **After editing `SLACK_CHANNELS`, manually trigger a deploy.** The Lambda reads the list at deploy time, not at invocation time, so variable edits don't take effect until the next `sam deploy`. GitHub doesn't emit an event on variable changes, so there's no auto-redeploy — run **Actions → Deploy → Run workflow** (the workflow already has `workflow_dispatch`) once you've saved the new value.

### Optional: production environment protection

Create a `production` environment in **Settings → Environments** and add deploy-protection rules (required reviewers, wait timer, branch restrictions). The workflow already references `environment: production`, so the rules take effect automatically — no workflow change needed.

## Notes

- **Scheduling:** the cron runs on EventBridge Scheduler with `ScheduleExpressionTimezone: America/New_York`, so 8:00 AM ET stays fixed year-round across DST transitions.
- **Stateless:** no DB. Every reaction event re-fetches the full reaction state, so a dropped event self-heals on the next reaction.
- **Weather fallback:** the scheduled post retries the NWS fetch up to 3 times (8s timeout each, 500ms between attempts) so a transient NWS hiccup doesn't drop the weather line. Only after all 3 attempts fail does the bot post without weather.
