# Multi-channel fanout + `/ball edit` design

Date: 2026-04-11

## Goals

Two small, independent features:

1. **Multi-channel fanout.** Let the bot post identical messages to N Slack channels at once. Primary use case: running a test channel in parallel with the real channel during development.
2. **`/ball edit <text>`.** Let a user fix the header text of the most recent bot message in the channel where they run the command, without losing the current roster (reactions).

Both features should preserve existing behavior for single-channel deploys and existing `/ball <text>` usage.

## Non-goals

- Per-channel schedules, rosters, headers, or weather locations. Fanout is identical message to all channels.
- Editing messages fan-out style across multiple channels at once. Edit is scoped to the channel the command was run in.
- Editing messages posted by someone other than the bot.
- Persistent message store (DynamoDB, etc.). Target message for edit is found via `conversations.history`.
- New Slack OAuth scopes. Both features should work with current scopes (`chat:write`, `channels:history`, `reactions:read`, `users:read`).

## Feature 1: Multi-channel fanout

### Config

Rename the env var:

- `SLACK_CHANNEL` → `SLACK_CHANNELS` (comma-separated list of channel IDs).
- A single value remains valid; existing deploys just rename the variable.
- Empty / missing → handler throws at startup (same as today).

Files touched:

- `.env.example`
- `scripts/deploy.sh` (required list + `--parameter-overrides`)
- `scripts/run-postMessage.js` (required list)
- `infra/template.yaml` (`SlackChannel` param → `SlackChannels`, env var rename)
- `README.md` (env var doc, note that the bot must be invited to every listed channel)

### Parsing

Add a helper in `src/shared/slack.js`:

```js
export function parseChannels(envValue) {
  return (envValue ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
```

One location, reused by both handlers.

### `postMessage/handler.js` fanout

1. Build the text once (existing logic).
2. `parseChannels(process.env.SLACK_CHANNELS)` → array.
3. `Promise.allSettled` one `postMessage({ token, channel, text })` per entry.
4. For each `rejected` result, call `notifyFailure` with the failing channel in `context`.
5. If **all** channels rejected, re-throw so EventBridge retries. If at least one succeeded, return success (no retry storm when one channel is healthy).

### `slashCommand/handler.js` fanout (create flow)

Same fanout pattern. The ephemeral acknowledgement to the user reports outcome:

- All OK: no ephemeral needed (200 empty body, matching current behavior).
- Partial failure: ephemeral `posted to N of M channels (failures DMed)`.
- Total failure: ephemeral `internal error` (matches current error path).

### Reaction handler

No change required. It already keys on `inner.item.channel` from the Slack event payload, so it works on any channel the bot is in.

### Tests

Update `test/postMessageHandler.test.js` and `test/slashCommandHandler.test.js`:

- Set `SLACK_CHANNELS` (a single ID for existing assertions, plus new multi-channel cases).
- New case: two channels, both succeed → two `chat.postMessage` calls, both channels present.
- New case: two channels, first fails → second still attempted, `notifyFailure` called once with the failing channel, handler still returns success.
- New case: all channels fail → handler throws (`postMessage`) / returns 500 (`slashCommand`).

## Feature 2: `/ball edit <text>`

### Command parsing

In `slashCommand/handler.js`, after trimming `text`:

- If the trimmed text matches `/^edit(\s+|$)/i`, branch into the edit flow with `editText = text.slice(4).trim()`.
- Otherwise run the current create flow unchanged.

If `editText` is empty:

```
Usage: `/ball edit <new message>` — e.g. `/ball edit tonight at 8pm instead`
```

### Target resolution

Edit operates on the channel the command was run in — use `channel_id` from the form-encoded Slack payload, **not** `SLACK_CHANNELS`. Rationale: edits are surgical; fanning edits out across channels would be surprising, and this way a user in a test channel can fix the test-channel copy without touching production.

Steps:

1. `conversations.history` with `channel=channel_id`, `limit=20`.
2. Walk messages newest-first; take the first one where `message.user === SLACK_BOT_USER_ID`.
3. If none found → ephemeral `no recent bball message to edit in this channel`. No Slack writes.

This requires a new wrapper in `src/shared/slack.js`:

```js
export function getChannelHistory({ token, channel, limit = 20 }) {
  return callGet('conversations.history', token, { channel, limit: String(limit) });
}
```

Distinct from the existing `getHistory({ token, channel, ts })` which fetches a single message around a timestamp.

### Re-rendering

Once target `ts` is known:

1. `getReactions({ token, channel, ts })` → feed into the existing `categorize(reactions, botUserId)` from `src/reactionHandler/categorize.js`. Re-export or import directly — `slashCommand` already imports from `reactionHandler` for `verifySignature`, so the precedent exists.
2. `fetchWeather(owmKey, { timeoutMs: WEATHER_TIMEOUT_MS, target: 'now' })` — same call the create flow uses. Rationale: the common reason to edit is time change, and a fresh weather snapshot matches the new time.
3. `displayName` via `getUserInfo` — same as create flow.
4. `headerText = \`${editText} (${displayName})\`` — same format as create flow.
5. `formatMessage(roster, weather, { headerText })` → new body.
6. `updateMessage({ token, channel: channel_id, ts, text: newBody })`.

### Slack scopes

Already present (reaction handler uses `channels:history` and `reactions:read`). Verify in the Slack app manifest during implementation; no change expected.

### Edge cases

- Empty `editText` → ephemeral usage message, no Slack calls.
- No bot message in last 20 history items → ephemeral `no recent bball message to edit`, no Slack writes.
- Target message is a scheduled roll-call (header = `today?`) → still editable; the new header replaces `today?`. Acceptable.
- `chat.update` fails → `notifyFailure` with `{ lambda: 'slashCommand', phase: 'chat.update', channel, ts }` + ephemeral `internal error`.
- Weather fetch fails → same fallback as create flow (log, continue with `weather=null`).
- `users.info` fails → same fallback as create flow (log, use `user_name`).

### Tests

New cases in `test/slashCommandHandler.test.js`:

- **Happy path edit.** `text='edit 8pm'`, history returns one bot message, reactions return a roster → `chat.update` called once with the new header and preserved roster; `chat.postMessage` not called.
- **No recent bot message.** History returns only non-bot messages → ephemeral error, no `chat.update`.
- **Empty edit text.** `text='edit'` or `text='edit   '` → ephemeral usage, no Slack calls.
- **Edit + multi-channel.** `SLACK_CHANNELS='A,B'`, command run in channel A → only channel A is read and updated. Channel B is untouched.
- **Create flow unchanged.** `text='tonight at 7pm'` still runs the existing create flow and fans out.

## Risks / open questions

- **Slack rate limits under fanout.** For 2 channels this is a non-issue. Noted for anyone later bumping this to many channels.
- **`parseHeader` / `parseWeatherLine` assumptions.** The edit flow re-parses roster from reactions (not from text), so it doesn't depend on `parseHeader`. But `formatMessage` still needs weather — we re-fetch rather than parse. That's intentional and keeps the edit flow decoupled from text parsing.
- **Edit target ambiguity.** If two `/ball` posts happened in quick succession, "most recent bot message" might not be what the user expected. Acceptable: they can post a fresh one. Documented as a known limitation.
