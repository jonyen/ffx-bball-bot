# Basketball Slack Bot — Design

## Overview

A Slack bot that posts a basketball roll-call message twice a week (Tuesdays and Thursdays at 8am EST) to a specific channel. It watches for reactions on the message and updates the message body in-place to show who's In, Out, or Unsure. The initial message also includes the current weather for Fairfax, VA.

## Goals

- Automate the twice-weekly basketball check-in so nobody has to post manually.
- Give everyone a single up-to-date roster at a glance, updated live via emoji reactions.
- Show weather conditions so people can make an informed call.
- Keep infrastructure cost effectively zero.

## Non-Goals

- No historical attendance tracking or stats.
- No DMs, reminders, or follow-ups.
- No support for multiple channels or teams in this iteration.
- No persistence layer — the bot is stateless.

## Architecture

Two AWS Lambda functions, each with a single responsibility:

```
EventBridge (cron: Tue/Thu 8am EST)
    -> postMessage Lambda
        -> OpenWeatherMap API (fetch weather for Fairfax, VA)
        -> Slack API (chat.postMessage)

Slack Event Subscription (reaction_added / reaction_removed)
    -> API Gateway (HTTP API, POST /slack/events)
        -> reactionHandler Lambda
            -> Slack API (conversations.history to verify authorship,
                          reactions.get to fetch current state,
                          chat.update to rewrite the message)
```

### Components

- **postMessage Lambda** — triggered by EventBridge cron. Fetches weather, formats the initial message, posts to Slack.
- **reactionHandler Lambda** — triggered by API Gateway on Slack Event subscription webhooks. Verifies the Slack signature, checks the reacted message was posted by this bot, re-fetches the full reaction state, and rewrites the message body.
- **API Gateway HTTP API** — single `POST /slack/events` route that proxies to the reactionHandler Lambda.
- **EventBridge rule** — cron schedule `cron(0 13 ? * TUE,THU *)` (13:00 UTC = 8am EST; Daylight Saving shifts are accepted — the bot will post at 9am EDT during DST months, which is acceptable for this use case).
- **IAM roles** — least-privilege, one per Lambda.

## Runtime & Hosting

- **Language:** Node.js 20.x
- **Cloud:** AWS (Lambda + API Gateway + EventBridge)
- **Deployment:** AWS SAM (`sam build && sam deploy`)
- **Expected cost:** $0/month under AWS free tier (well under 1M Lambda invocations, well under EventBridge free allowance)

## Configuration

Both Lambdas read the following environment variables:

- `SLACK_BOT_TOKEN` — Slack bot OAuth token (xoxb-...)
- `SLACK_SIGNING_SECRET` — used by reactionHandler to verify incoming webhook signatures
- `OPENWEATHERMAP_API_KEY` — OpenWeatherMap API key
- `SLACK_CHANNEL` — target channel; defaults to `C03H7SUSUTZ`

## Message Format

### Initial post (when no reactions yet)

```
🏀 Basketball today?

──────────────
☀️ Fairfax, VA — 72°F, Clear skies
```

### With reactions

```
🏀 Basketball today?

In: <@U123>, <@U456>
Out: <@U789>
Unsure: <@U012>

──────────────
☀️ Fairfax, VA — 72°F, Clear skies
```

- User references use `<@USERID>` mention syntax so Slack renders them as clickable mentions.
- Categories (`In:`, `Out:`, `Unsure:`) only appear when at least one user falls into that category.
- Weather line is frozen at post time and never updated.

## Reaction Categorization

| Emoji | Category |
|---|---|
| `basketball` | In |
| `+1` (thumbs up) | In |
| `white_check_mark` | In |
| `x` | Out |
| `-1` (thumbs down) | Out |
| anything else | Unsure |

### Same-user conflict rules

Because we re-fetch the full reaction state on every event, we always compute categories from scratch. If one user has reactions in multiple categories:

1. If they have any reaction in In **or** Out, they are only counted in that category (never Unsure).
2. If they have reactions in both In and Out, In wins (assume they intend to play; reactions are additive and users rarely remove mis-clicks).
3. The bot's own user ID is filtered out of every category.

## Weather

- **API:** OpenWeatherMap Current Weather Data (`/data/2.5/weather`)
- **Location:** Fairfax, VA (lat `38.8462`, lon `-77.3064`)
- **Units:** `imperial` (Fahrenheit)
- **Called once** at post time; baked into the initial message and preserved across all subsequent updates.
- **Icon:** pick an emoji based on the `weather[0].main` field (Clear → ☀️, Clouds → ☁️, Rain → 🌧️, Snow → ❄️, Thunderstorm → ⛈️, default → 🌡️).
- **Fallback:** if the API call fails or times out (3s timeout), post the message without the weather line and log the error to CloudWatch.

## Reaction Handler Flow

1. Verify Slack signature using `SLACK_SIGNING_SECRET` and the `X-Slack-Signature` + `X-Slack-Request-Timestamp` headers. Reject with 401 if invalid.
2. If the event is Slack's `url_verification` challenge, echo back the `challenge` value and return 200.
3. Parse the event. If it is not `reaction_added` or `reaction_removed`, return 200 (no-op).
4. Call `conversations.history` for the reacted message's channel/timestamp. If the message's `user` field does not match the bot's own user ID, return 200 (no-op).
5. Call `reactions.get` to fetch the current reaction state for the message.
6. Categorize each user who has reacted, filtering out the bot itself.
7. Build the new message body using the original weather line (parsed out of the existing message) and the computed roster.
8. Call `chat.update` with the new text. Return 200.

## Error Handling

- **Weather API failure:** post the message without the weather line. Log the error.
- **Slack `chat.postMessage` failure:** EventBridge will retry the Lambda invocation twice. If all retries fail, the post is missed for that day (acceptable; we don't back-fill).
- **Slack `chat.update` failure in reactionHandler:** return 500 so Slack retries the webhook (Slack retries up to 3 times with backoff).
- **Invalid Slack signature:** return 401.
- **Unknown event type:** return 200 with no action (Slack expects a 2xx).
- **Reaction on a non-bot message:** return 200 with no action.

## Testing

- **Unit tests (Vitest):**
  - `categorize.test.js` — every emoji → category mapping, conflict resolution rules, bot-user filtering
  - `formatMessage.test.js` — initial message, message with reactions in all/some/no categories, mention rendering
  - `weather.test.js` — parsing OpenWeatherMap responses, icon selection, fallback behavior
  - `verifySignature.test.js` — valid and invalid signatures
- **Manual integration test:** a local script that invokes the postMessage handler with mocked or real credentials to verify a message appears in a test channel.

## Project Structure

```
ffx-bball/
├── src/
│   ├── postMessage/
│   │   ├── handler.js          # Lambda entry point
│   │   ├── weather.js          # OpenWeatherMap client
│   │   └── formatMessage.js    # Initial message format
│   ├── reactionHandler/
│   │   ├── handler.js          # Lambda entry point
│   │   ├── verifySignature.js  # Slack signature verification
│   │   ├── categorize.js       # Reaction → category mapping
│   │   └── formatMessage.js    # Updated message format
│   └── shared/
│       └── slack.js            # Slack API client wrapper
├── test/
│   ├── categorize.test.js
│   ├── formatMessage.test.js
│   ├── weather.test.js
│   └── verifySignature.test.js
├── infra/
│   └── template.yaml           # AWS SAM template
├── package.json
├── .env.example
└── README.md
```

## Deployment

1. Create a Slack app in the target workspace with:
   - Bot token scopes: `chat:write`, `reactions:read`, `channels:history`, `groups:history`
   - Event subscriptions: `reaction_added`, `reaction_removed` (pointing at the API Gateway URL after first deploy)
2. Create an OpenWeatherMap account and grab an API key.
3. Populate `.env` from `.env.example`.
4. `sam build && sam deploy --guided` — SAM creates both Lambdas, API Gateway, EventBridge rule, and IAM roles.
5. Take the API Gateway URL from the SAM output and paste it into the Slack Event Subscription settings.
6. Invite the bot to channel `C03H7SUSUTZ`.

## Open Questions / Future Considerations

- DST: the EventBridge cron is anchored to UTC, so the bot posts at 8am EST in winter and 9am EDT in summer. If that's undesirable, move to a Lambda that self-schedules or use two cron rules.
- No persistence means if the bot is down when a reaction comes in and Slack's retries exhaust, that reaction is lost (though a subsequent reaction will re-sync the full state).
