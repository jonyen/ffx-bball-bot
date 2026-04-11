# ffx-bball-bot

Slack bot that posts a basketball roll-call to a channel twice a week (Tue/Thu 8am EST) and tracks RSVPs via emoji reactions. Weather for Fairfax, VA is baked into the initial post.

Design doc: `docs/superpowers/specs/2026-04-09-basketball-slack-bot-design.md`

## Architecture

Three AWS Lambda functions:

- **postMessage** — EventBridge Scheduler cron triggers it Tue/Thu 8:00 AM America/New_York (DST-aware). Fetches weather, formats, posts the default `🏀 today?` roll-call.
- **reactionHandler** — API Gateway HTTP API route `POST /slack/events`. Verifies signature, re-fetches reaction state, rewrites the message via `chat.update`. Preserves any custom header (e.g. from `/ball`).
- **slashCommand** — API Gateway HTTP API route `POST /slack/commands`. Handles `/ball <message>` — posts an ad-hoc roll-call to the channel where the command was invoked, with the user's custom header text and a mention attributing the caller. The reactionHandler handles reactions on these the same way it does scheduled posts.

On any unrecoverable send-time failure in any Lambda, a DM is sent to `U05SWHWFTEH` via `chat.postMessage`. This is application-level error notification — it only fires inside the Lambdas, not on infra errors.

## /ball slash command

```
/ball :basketball: tonight at 7pm, outdoor courts
```

Renders as:

```
🏀 tonight at 7pm, outdoor courts (alice)

──────────────
☀️ Fairfax, VA — 72°F, Clear sky
```

- The bot posts the user's text verbatim — no auto-prepended emoji. Type `:basketball:` (or any other emoji) yourself if you want one in the header.
- `/ball` posts only to the channel where the command was invoked; the multi-channel `SLACK_CHANNELS` fanout only applies to the scheduled post.
- Empty invocations (`/ball` with no text) respond with an ephemeral usage hint.
- Weather fetch uses a 2-second timeout (vs. 3s for the scheduled post) to stay inside Slack's 3-second slash command deadline; on timeout the message posts without the weather line.
- Reactions on `/ball` posts work identically to scheduled posts — the existing header is preserved on rewrite.

To fix a typo or change the time after posting, run:

```
/ball edit <new message>
```

This rewrites the most recent bball message in the current channel with the new header text, preserving the current reactions (In/Out/Unsure) and refreshing the weather for "now". It only touches the channel where the command is run — other channels in `SLACK_CHANNELS` are left alone.

### Viewing and updating the scheduled post

```
/ball schedule
```

Shows the current EventBridge schedule that drives the twice-weekly post (expression, timezone, enabled state) as an ephemeral message. Update it with:

```
/ball schedule <cron expression>
```

Examples:

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
| `x`, `-1` | Out |
| anything else | Unsure |

If a user lands in multiple categories, In > Out > Unsure.

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
    slack.js         # Slack API client + notifyFailure
    formatMessage.js # shared message formatter (+ parseHeader, parseWeatherLine)
    scheduler.js     # EventBridge Scheduler client for /ball schedule
test/                # vitest
infra/
  template.yaml      # AWS SAM
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
- `OPENWEATHERMAP_API_KEY` — OpenWeatherMap API key
- `SLACK_CHANNELS` — comma-separated list of target channel IDs (default: `C03H7SUSUTZ`). The bot must be invited to each channel.

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

## Notes

- **Scheduling:** the cron runs on EventBridge Scheduler with `ScheduleExpressionTimezone: America/New_York`, so 8:00 AM ET stays fixed year-round across DST transitions.
- **Stateless:** no DB. Every reaction event re-fetches the full reaction state, so a dropped event self-heals on the next reaction.
- **Weather fallback:** if OpenWeatherMap fails or times out (3s), the bot posts without the weather line.
