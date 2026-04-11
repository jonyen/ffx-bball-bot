# ffx-bball-bot

Slack bot that posts a basketball roll-call to a channel twice a week (Tue/Thu 8am EST) and tracks RSVPs via emoji reactions. Weather for Fairfax, VA is baked into the initial post.

Design doc: `docs/superpowers/specs/2026-04-09-basketball-slack-bot-design.md`

## Architecture

Three AWS Lambda functions:

- **postMessage** — EventBridge Scheduler cron triggers it Tue/Thu 8:00 AM America/New_York (DST-aware). Fetches weather, formats, posts the default `🏀 today?` roll-call.
- **reactionHandler** — API Gateway HTTP API route `POST /slack/events`. Verifies signature, re-fetches reaction state, rewrites the message via `chat.update`. Preserves any custom header (e.g. from `/ball`).
- **slashCommand** — API Gateway HTTP API route `POST /slack/commands`. Handles `/ball <message>` — posts an ad-hoc roll-call with the user's custom header text and a mention attributing the caller. The reactionHandler handles reactions on these the same way it does scheduled posts.

On any unrecoverable send-time failure in any Lambda, a DM is sent to `U05SWHWFTEH` via `chat.postMessage`. This is application-level error notification — it only fires inside the Lambdas, not on infra errors.

## /ball slash command

```
/ball tonight at 7pm, outdoor courts
```

Renders as:

```
🏀 tonight at 7pm, outdoor courts — @alice

──────────────
☀️ Fairfax, VA — 72°F, Clear sky
```

- Empty invocations (`/ball` with no text) respond with an ephemeral usage hint.
- Weather fetch uses a 2-second timeout (vs. 3s for the scheduled post) to stay inside Slack's 3-second slash command deadline; on timeout the message posts without the weather line.
- Reactions on `/ball` posts work identically to scheduled posts — the custom header is parsed out of the existing message and preserved on rewrite.

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

- `SLACK_BOT_TOKEN` — xoxb-... with scopes `chat:write`, `reactions:read`, `channels:history`, `groups:history`
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

Required bot token scopes: `chat:write`, `reactions:read`, `channels:history`, `groups:history`, `commands`.

## Notes

- **Scheduling:** the cron runs on EventBridge Scheduler with `ScheduleExpressionTimezone: America/New_York`, so 8:00 AM ET stays fixed year-round across DST transitions.
- **Stateless:** no DB. Every reaction event re-fetches the full reaction state, so a dropped event self-heals on the next reaction.
- **Weather fallback:** if OpenWeatherMap fails or times out (3s), the bot posts without the weather line.
