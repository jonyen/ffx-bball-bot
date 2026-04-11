# Multi-channel Fanout + `/ball edit` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the bot to fan the roll-call message out to multiple Slack channels (single identical message) and let users fix a previous `/ball` post's header via `/ball edit <text>` without losing the current roster.

**Architecture:** Two independent features layered on the existing Lambda handlers. Multi-channel is an env var rename (`SLACK_CHANNEL` → `SLACK_CHANNELS`) plus a `Promise.allSettled` fanout in `postMessage` and `slashCommand` create flows. `/ball edit` is a new branch inside the slash command handler that fetches recent channel history, finds the bot's latest message, re-renders it with the current reactions + fresh weather + the new header text, and calls `chat.update`. No persistence layer, no new Slack scopes.

**Tech Stack:** Node.js 20 (ESM), Vitest, AWS SAM, Slack Web API (`chat.postMessage`, `chat.update`, `conversations.history`, `reactions.get`, `users.info`).

**Spec:** `docs/superpowers/specs/2026-04-11-multi-channel-and-edit-design.md`

---

## Task 1: Add `parseChannels` helper

**Files:**
- Modify: `src/shared/slack.js`
- Test: `test/slack.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/slack.test.js`:

```js
import { parseChannels } from '../src/shared/slack.js';

describe('parseChannels', () => {
  test('splits a comma-separated list and trims whitespace', () => {
    expect(parseChannels('C1,C2, C3 ')).toEqual(['C1', 'C2', 'C3']);
  });

  test('returns a single entry when there is no comma', () => {
    expect(parseChannels('C1')).toEqual(['C1']);
  });

  test('drops empty entries from trailing or duplicate commas', () => {
    expect(parseChannels('C1,,C2,')).toEqual(['C1', 'C2']);
  });

  test('returns an empty array for undefined, null, or empty input', () => {
    expect(parseChannels(undefined)).toEqual([]);
    expect(parseChannels(null)).toEqual([]);
    expect(parseChannels('')).toEqual([]);
    expect(parseChannels('   ')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run test/slack.test.js -t parseChannels`
Expected: FAIL — `parseChannels is not a function` / `not exported`.

- [ ] **Step 3: Implement `parseChannels`**

Add to `src/shared/slack.js` (anywhere in the module, above `notifyFailure` is fine):

```js
export function parseChannels(envValue) {
  return (envValue ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/slack.test.js -t parseChannels`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared/slack.js test/slack.test.js
git commit -m "feat(slack): add parseChannels helper"
```

---

## Task 2: `postMessage` handler fanout

**Files:**
- Modify: `src/postMessage/handler.js`
- Test: `test/postMessageHandler.test.js`

- [ ] **Step 1: Update existing test setup to use `SLACK_CHANNELS`**

In `test/postMessageHandler.test.js`:

Replace the line `process.env.SLACK_CHANNEL = 'C_TEST';` inside `beforeEach` with:

```js
  process.env.SLACK_CHANNELS = 'C_TEST';
  delete process.env.SLACK_CHANNEL;
```

Also add `parseChannels` to the `vi.mock` of `../src/shared/slack.js` near the top:

```js
vi.mock('../src/shared/slack.js', () => ({
  postMessage: vi.fn(),
  notifyFailure: vi.fn(),
  parseChannels: (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  FAILURE_DM_USER: 'U0000000000',
}));
```

(Mocking `parseChannels` with the real implementation avoids pulling in the full module while keeping behavior identical.)

- [ ] **Step 2: Write failing tests for the new multi-channel behaviors**

Append inside `describe('postMessage handler', ...)` in `test/postMessageHandler.test.js`:

```js
  test('fans out to every channel in SLACK_CHANNELS', async () => {
    process.env.SLACK_CHANNELS = 'C_ONE, C_TWO';
    fetchWeather.mockResolvedValue({ icon: '☀️', tempF: 72, description: 'Clear sky' });
    postMessage.mockResolvedValue({ ok: true, ts: '1.2' });

    await handler({});

    expect(postMessage).toHaveBeenCalledTimes(2);
    const channels = postMessage.mock.calls.map((c) => c[0].channel);
    expect(channels).toEqual(['C_ONE', 'C_TWO']);
    const texts = postMessage.mock.calls.map((c) => c[0].text);
    expect(texts[0]).toBe(texts[1]);
    expect(notifyFailure).not.toHaveBeenCalled();
  });

  test('on partial failure: notifies per failure, still posts to healthy channels, does not throw', async () => {
    process.env.SLACK_CHANNELS = 'C_ONE,C_TWO';
    fetchWeather.mockResolvedValue(null);
    postMessage
      .mockRejectedValueOnce(new Error('slack down'))
      .mockResolvedValueOnce({ ok: true, ts: '1.2' });

    await handler({});

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(notifyFailure).toHaveBeenCalledTimes(1);
    const ctx = notifyFailure.mock.calls[0][0];
    expect(ctx.context.lambda).toBe('postMessage');
    expect(ctx.context.channel).toBe('C_ONE');
  });

  test('on total failure: notifies once per channel and rethrows', async () => {
    process.env.SLACK_CHANNELS = 'C_ONE,C_TWO';
    fetchWeather.mockResolvedValue(null);
    postMessage.mockRejectedValue(new Error('slack down'));

    await expect(handler({})).rejects.toThrow('slack down');

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(notifyFailure).toHaveBeenCalledTimes(2);
  });
```

Also update the existing test `'notifies failure and rethrows when chat.postMessage throws'` — it currently sets `SLACK_CHANNEL` implicitly via `beforeEach`. That becomes `SLACK_CHANNELS='C_TEST'` which is a 1-channel list, so the total-failure branch should still rethrow. No changes needed to that test's body; the updated `beforeEach` covers it.

- [ ] **Step 3: Run the tests and verify they fail**

Run: `npx vitest run test/postMessageHandler.test.js`
Expected: FAIL — existing tests still pass (one channel `C_TEST`), new multi-channel tests fail because the handler only posts to one channel and throws on the first rejection.

- [ ] **Step 4: Update `src/postMessage/handler.js` to fan out**

Replace the file contents with:

```js
import { fetchWeather } from './weather.js';
import { formatMessage } from '../shared/formatMessage.js';
import { postMessage, notifyFailure, parseChannels } from '../shared/slack.js';

const EMPTY_ROSTER = { in: [], out: [], unsure: [] };

export async function handler(_event) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channels = parseChannels(process.env.SLACK_CHANNELS);
  const owmKey = process.env.OPENWEATHERMAP_API_KEY;

  let weather = null;
  try {
    weather = await fetchWeather(owmKey);
  } catch (err) {
    console.error('weather fetch failed', err);
  }

  const text = formatMessage(EMPTY_ROSTER, weather);

  const results = await Promise.allSettled(
    channels.map((channel) => postMessage({ token, channel, text })),
  );

  const failures = [];
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    if (result.status === 'rejected') {
      const channel = channels[i];
      failures.push({ channel, error: result.reason });
      await notifyFailure({
        token,
        error: result.reason,
        context: {
          lambda: 'postMessage',
          phase: 'chat.postMessage',
          channel,
        },
      });
    }
  }

  if (failures.length === channels.length && channels.length > 0) {
    throw failures[0].error;
  }

  return results
    .filter((r) => r.status === 'fulfilled')
    .map((r) => r.value);
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npx vitest run test/postMessageHandler.test.js`
Expected: PASS — all tests green, including the 3 new multi-channel cases.

- [ ] **Step 6: Commit**

```bash
git add src/postMessage/handler.js test/postMessageHandler.test.js
git commit -m "feat(postMessage): fan out to multiple channels via SLACK_CHANNELS"
```

---

## Task 3: `slashCommand` create-flow fanout

**Files:**
- Modify: `src/slashCommand/handler.js`
- Test: `test/slashCommandHandler.test.js`

- [ ] **Step 1: Update existing test setup to use `SLACK_CHANNELS`**

In `test/slashCommandHandler.test.js`:

Replace `process.env.SLACK_CHANNEL = 'C_TEST';` inside `beforeEach` with:

```js
  process.env.SLACK_CHANNELS = 'C_TEST';
  delete process.env.SLACK_CHANNEL;
```

Add `parseChannels` to the `vi.mock` of `../src/shared/slack.js`:

```js
vi.mock('../src/shared/slack.js', () => ({
  postMessage: vi.fn(),
  getUserInfo: vi.fn(),
  notifyFailure: vi.fn(),
  parseChannels: (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  FAILURE_DM_USER: 'U0000000000',
}));
```

- [ ] **Step 2: Write failing tests for multi-channel behaviors**

Append inside `describe('slashCommand handler', ...)`:

```js
  test('fans out the create flow to every channel in SLACK_CHANNELS', async () => {
    process.env.SLACK_CHANNELS = 'C_ONE,C_TWO';
    fetchWeather.mockResolvedValue(null);
    postMessage.mockResolvedValue({ ok: true, ts: '1.2' });

    const res = await handler(
      event({ command: '/ball', text: '7pm', user_id: 'U123', user_name: 'alice' }),
    );

    expect(res.statusCode).toBe(200);
    expect(postMessage).toHaveBeenCalledTimes(2);
    const channels = postMessage.mock.calls.map((c) => c[0].channel);
    expect(channels).toEqual(['C_ONE', 'C_TWO']);
    expect(notifyFailure).not.toHaveBeenCalled();
  });

  test('partial fanout failure: notifies per failure and returns an ephemeral warning', async () => {
    process.env.SLACK_CHANNELS = 'C_ONE,C_TWO';
    fetchWeather.mockResolvedValue(null);
    postMessage
      .mockRejectedValueOnce(new Error('slack down'))
      .mockResolvedValueOnce({ ok: true, ts: '1.2' });

    const res = await handler(
      event({ command: '/ball', text: '7pm', user_id: 'U123', user_name: 'alice' }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.response_type).toBe('ephemeral');
    expect(body.text).toMatch(/1 of 2/);
    expect(notifyFailure).toHaveBeenCalledTimes(1);
    expect(notifyFailure.mock.calls[0][0].context.channel).toBe('C_ONE');
  });

  test('total fanout failure: notifies and returns 500', async () => {
    process.env.SLACK_CHANNELS = 'C_ONE,C_TWO';
    fetchWeather.mockResolvedValue(null);
    postMessage.mockRejectedValue(new Error('slack down'));

    const res = await handler(
      event({ command: '/ball', text: '7pm', user_id: 'U123', user_name: 'alice' }),
    );

    expect(res.statusCode).toBe(500);
    expect(notifyFailure).toHaveBeenCalledTimes(2);
  });
```

The existing single-failure test (`'notifies failure and returns 500 when chat.postMessage throws'`) still works: with `SLACK_CHANNELS='C_TEST'` it's a one-channel list, one rejection → total failure → 500.

- [ ] **Step 3: Run the tests and verify they fail**

Run: `npx vitest run test/slashCommandHandler.test.js`
Expected: FAIL — multi-channel tests fail because the handler only posts once and has no ephemeral partial-failure branch.

- [ ] **Step 4: Update the create flow in `src/slashCommand/handler.js`**

Rewrite the post block at the bottom of the handler (currently lines 76-92) to fan out. Replace:

```js
  const body = formatMessage(EMPTY_ROSTER, weather, { headerText });

  try {
    await postMessage({ token, channel, text: body });
    return response(200);
  } catch (err) {
    await notifyFailure({
      token,
      error: err,
      context: {
        lambda: 'slashCommand',
        user: userId,
        channel,
      },
    });
    return response(500, 'internal error');
  }
}
```

with:

```js
  const body = formatMessage(EMPTY_ROSTER, weather, { headerText });

  const results = await Promise.allSettled(
    channels.map((channel) => postMessage({ token, channel, text: body })),
  );

  const failures = [];
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    if (result.status === 'rejected') {
      const channel = channels[i];
      failures.push({ channel, error: result.reason });
      await notifyFailure({
        token,
        error: result.reason,
        context: {
          lambda: 'slashCommand',
          phase: 'chat.postMessage',
          user: userId,
          channel,
        },
      });
    }
  }

  if (failures.length === channels.length) {
    return response(500, 'internal error');
  }

  if (failures.length > 0) {
    const okCount = channels.length - failures.length;
    return ephemeral(
      `Posted to ${okCount} of ${channels.length} channels. ${failures.length} failed (DM sent).`,
    );
  }

  return response(200);
}
```

Also update the env reads and imports at the top of the handler. Change:

```js
import { postMessage, getUserInfo, notifyFailure } from '../shared/slack.js';
```

to:

```js
import {
  postMessage,
  getUserInfo,
  notifyFailure,
  parseChannels,
} from '../shared/slack.js';
```

And inside `handler`, replace:

```js
  const channel = process.env.SLACK_CHANNEL;
```

with:

```js
  const channels = parseChannels(process.env.SLACK_CHANNELS);
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npx vitest run test/slashCommandHandler.test.js`
Expected: PASS — all tests green.

- [ ] **Step 6: Commit**

```bash
git add src/slashCommand/handler.js test/slashCommandHandler.test.js
git commit -m "feat(slashCommand): fan out /ball create flow to multiple channels"
```

---

## Task 4: Rename the env var across scripts, infra, and docs

**Files:**
- Modify: `.env.example`
- Modify: `scripts/deploy.sh`
- Modify: `scripts/run-postMessage.js`
- Modify: `infra/template.yaml`
- Modify: `README.md`

- [ ] **Step 1: Update `.env.example`**

Change `SLACK_CHANNEL=C0123456789` to:

```
# Comma-separated list of Slack channel IDs. The bot must be a member of every channel.
SLACK_CHANNELS=C0123456789
```

- [ ] **Step 2: Update `scripts/deploy.sh`**

Replace `SLACK_CHANNEL` in the `required=(...)` array with `SLACK_CHANNELS`, and replace `SlackChannel=$SLACK_CHANNEL` in `--parameter-overrides` with `SlackChannels=$SLACK_CHANNELS`.

- [ ] **Step 3: Update `scripts/run-postMessage.js`**

Replace the required array entry `'SLACK_CHANNEL'` with `'SLACK_CHANNELS'`, and update the console log from `Posting to ${process.env.SLACK_CHANNEL}...` to `Posting to ${process.env.SLACK_CHANNELS}...`.

- [ ] **Step 4: Update `infra/template.yaml`**

Change the `SlackChannel` parameter to `SlackChannels`:

```yaml
  SlackChannels:
    Type: String
    Default: C0123456789
    Description: Comma-separated list of target Slack channel IDs
```

And in `Globals.Function.Environment.Variables`, change:

```yaml
        SLACK_CHANNEL: !Ref SlackChannel
```

to:

```yaml
        SLACK_CHANNELS: !Ref SlackChannels
```

- [ ] **Step 5: Update `README.md`**

Find the line documenting `SLACK_CHANNEL` (around line 83) and replace it with:

```
- `SLACK_CHANNELS` — comma-separated list of target channel IDs (default: `C0123456789`). The bot must be invited to each channel.
```

- [ ] **Step 6: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — all existing tests and the new multi-channel tests green.

- [ ] **Step 7: Commit**

```bash
git add .env.example scripts/deploy.sh scripts/run-postMessage.js infra/template.yaml README.md
git commit -m "chore: rename SLACK_CHANNEL to SLACK_CHANNELS across config"
```

---

## Task 5: Add `getChannelHistory` Slack wrapper

**Files:**
- Modify: `src/shared/slack.js`
- Test: `test/slack.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/slack.test.js`:

```js
import { getChannelHistory } from '../src/shared/slack.js';

describe('getChannelHistory', () => {
  test('GETs conversations.history with channel and limit', async () => {
    globalThis.fetch.mockResolvedValue(
      slackOk({
        messages: [
          { user: 'U_BOT', ts: '2.0', text: '🏀 earlier' },
          { user: 'U_HUMAN', ts: '1.0', text: 'hey' },
        ],
      }),
    );

    const result = await getChannelHistory({ token: TOKEN, channel: 'C1', limit: 20 });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const url = globalThis.fetch.mock.calls[0][0];
    expect(url).toContain('conversations.history');
    expect(url).toContain('channel=C1');
    expect(url).toContain('limit=20');
    expect(result.messages).toHaveLength(2);
  });

  test('defaults limit to 20 when not provided', async () => {
    globalThis.fetch.mockResolvedValue(slackOk({ messages: [] }));

    await getChannelHistory({ token: TOKEN, channel: 'C1' });

    const url = globalThis.fetch.mock.calls[0][0];
    expect(url).toContain('limit=20');
  });

  test('throws when Slack returns not-ok', async () => {
    globalThis.fetch.mockResolvedValue(slackErr('channel_not_found'));

    await expect(
      getChannelHistory({ token: TOKEN, channel: 'CX' }),
    ).rejects.toThrow(/channel_not_found/);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run test/slack.test.js -t getChannelHistory`
Expected: FAIL — `getChannelHistory is not a function`.

- [ ] **Step 3: Implement `getChannelHistory`**

Add to `src/shared/slack.js` near the other `callGet` wrappers (below `getHistory`):

```js
export function getChannelHistory({ token, channel, limit = 20 }) {
  return callGet('conversations.history', token, {
    channel,
    limit: String(limit),
  });
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/slack.test.js -t getChannelHistory`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared/slack.js test/slack.test.js
git commit -m "feat(slack): add getChannelHistory wrapper"
```

---

## Task 6: `/ball edit` command parsing + empty-text guard

**Files:**
- Modify: `src/slashCommand/handler.js`
- Test: `test/slashCommandHandler.test.js`

- [ ] **Step 1: Write the failing tests**

Append inside `describe('slashCommand handler', ...)`:

```js
  test('`/ball edit` with no new text returns an ephemeral usage hint', async () => {
    const res = await handler(
      event({
        command: '/ball',
        text: 'edit',
        user_id: 'U123',
        user_name: 'alice',
        channel_id: 'C_CURRENT',
      }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.response_type).toBe('ephemeral');
    expect(body.text).toMatch(/usage/i);
    expect(body.text).toMatch(/edit/i);
    expect(postMessage).not.toHaveBeenCalled();
  });

  test('`/ball edit   ` (whitespace-only) returns the same usage hint', async () => {
    const res = await handler(
      event({
        command: '/ball',
        text: 'edit   ',
        user_id: 'U123',
        user_name: 'alice',
        channel_id: 'C_CURRENT',
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).response_type).toBe('ephemeral');
    expect(postMessage).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run test/slashCommandHandler.test.js -t 'edit'`
Expected: FAIL — the handler currently treats `edit` as the header text and posts a roll-call with header "edit (Alice)".

- [ ] **Step 3: Add the edit-branch detection in `src/slashCommand/handler.js`**

Just above the `let displayName = userName;` block (after the empty-text check), insert:

```js
  const editMatch = /^edit(\s+(.*))?$/i.exec(text);
  if (editMatch) {
    const editText = (editMatch[2] ?? '').trim();
    if (!editText) {
      return ephemeral(
        'Usage: `/ball edit <new message>` — e.g. `/ball edit tonight at 8pm instead`',
      );
    }
    return handleEdit({
      token,
      botUserId: process.env.SLACK_BOT_USER_ID,
      channelId: params.get('channel_id') ?? '',
      userId,
      userName,
      editText,
      owmKey,
    });
  }
```

And add a stub `handleEdit` function near the top of the file, below the existing helpers:

```js
async function handleEdit(_args) {
  return ephemeral('edit flow not yet wired up');
}
```

(We will flesh `handleEdit` out in the next task. The stub is enough to make the two usage-error tests pass.)

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/slashCommandHandler.test.js`
Expected: PASS — new tests green, all existing tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/slashCommand/handler.js test/slashCommandHandler.test.js
git commit -m "feat(slashCommand): detect /ball edit and handle empty text"
```

---

## Task 7: `/ball edit` happy path — find, re-render, update

**Files:**
- Modify: `src/slashCommand/handler.js`
- Test: `test/slashCommandHandler.test.js`

- [ ] **Step 1: Extend the slack mock with the new helpers**

At the top of `test/slashCommandHandler.test.js`, update `vi.mock('../src/shared/slack.js', ...)` to include the three new helpers:

```js
vi.mock('../src/shared/slack.js', () => ({
  postMessage: vi.fn(),
  getUserInfo: vi.fn(),
  notifyFailure: vi.fn(),
  parseChannels: (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  getChannelHistory: vi.fn(),
  getReactions: vi.fn(),
  updateMessage: vi.fn(),
  FAILURE_DM_USER: 'U0000000000',
}));
```

Also add them to the corresponding `import` line below:

```js
import {
  postMessage,
  getUserInfo,
  notifyFailure,
  getChannelHistory,
  getReactions,
  updateMessage,
} from '../src/shared/slack.js';
```

And add a `SLACK_BOT_USER_ID` env to `beforeEach`:

```js
  process.env.SLACK_BOT_USER_ID = 'U_BOT';
```

- [ ] **Step 2: Write the happy-path failing test**

Append inside `describe('slashCommand handler', ...)`:

```js
  test('`/ball edit <text>` updates the most recent bot message with preserved roster', async () => {
    process.env.SLACK_CHANNELS = 'C_ONE,C_TWO';
    getChannelHistory.mockResolvedValue({
      ok: true,
      messages: [
        { user: 'U_HUMAN', ts: '3.0', text: 'hi' },
        { user: 'U_BOT', ts: '2.0', text: '🏀 tonight at 7pm (Alice)\n\nIn (1): <@U_HUMAN>' },
        { user: 'U_BOT', ts: '1.0', text: '🏀 yesterday (Alice)' },
      ],
    });
    getReactions.mockResolvedValue({
      ok: true,
      message: {
        reactions: [
          { name: 'basketball', users: ['U_HUMAN'], count: 1 },
        ],
      },
    });
    fetchWeather.mockResolvedValue({ icon: '☀️', tempF: 70, description: 'Clear sky' });
    updateMessage.mockResolvedValue({ ok: true });

    const res = await handler(
      event({
        command: '/ball',
        text: 'edit 8pm instead',
        user_id: 'U123',
        user_name: 'alice',
        channel_id: 'C_CURRENT',
      }),
    );

    expect(res.statusCode).toBe(200);

    // Only the origin channel is read.
    expect(getChannelHistory).toHaveBeenCalledTimes(1);
    expect(getChannelHistory).toHaveBeenCalledWith({
      token: 'xoxb-test',
      channel: 'C_CURRENT',
      limit: 20,
    });

    // Reactions fetched for the matched ts.
    expect(getReactions).toHaveBeenCalledWith({
      token: 'xoxb-test',
      channel: 'C_CURRENT',
      ts: '2.0',
    });

    // Weather re-fetched with the `now` target.
    expect(fetchWeather).toHaveBeenCalledWith('owm-key', {
      timeoutMs: 2000,
      target: 'now',
    });

    // chat.update called exactly once, only on the origin channel.
    expect(updateMessage).toHaveBeenCalledTimes(1);
    const call = updateMessage.mock.calls[0][0];
    expect(call.channel).toBe('C_CURRENT');
    expect(call.ts).toBe('2.0');
    expect(call.text).toBe(
      '🏀 8pm instead (Alice)\n\nIn (1): <@U_HUMAN>\n\n──────────────\n☀️ Fairfax, VA — 70°F, Clear sky',
    );

    // Create-flow side effects never fire.
    expect(postMessage).not.toHaveBeenCalled();
    expect(notifyFailure).not.toHaveBeenCalled();
  });
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `npx vitest run test/slashCommandHandler.test.js -t 'preserved roster'`
Expected: FAIL — `handleEdit` is still a stub.

- [ ] **Step 4: Implement `handleEdit` in `src/slashCommand/handler.js`**

At the top of the file, add imports:

```js
import { categorize } from '../reactionHandler/categorize.js';
```

and extend the existing shared slack import to include the new helpers:

```js
import {
  postMessage,
  getUserInfo,
  notifyFailure,
  parseChannels,
  getChannelHistory,
  getReactions,
  updateMessage,
} from '../shared/slack.js';
```

Replace the stub `handleEdit` with the full implementation:

```js
async function handleEdit({
  token,
  botUserId,
  channelId,
  userId,
  userName,
  editText,
  owmKey,
}) {
  if (!channelId) {
    return ephemeral('Could not determine the current channel.');
  }

  let history;
  try {
    history = await getChannelHistory({ token, channel: channelId, limit: 20 });
  } catch (err) {
    await notifyFailure({
      token,
      error: err,
      context: {
        lambda: 'slashCommand',
        phase: 'conversations.history',
        channel: channelId,
      },
    });
    return response(500, 'internal error');
  }

  const target = (history.messages ?? []).find((m) => m.user === botUserId);
  if (!target) {
    return ephemeral('No recent bball message to edit in this channel.');
  }

  const ts = target.ts;

  let reactions = [];
  try {
    const result = await getReactions({ token, channel: channelId, ts });
    reactions = result.message?.reactions ?? [];
  } catch (err) {
    await notifyFailure({
      token,
      error: err,
      context: {
        lambda: 'slashCommand',
        phase: 'reactions.get',
        channel: channelId,
        ts,
      },
    });
    return response(500, 'internal error');
  }
  const roster = categorize(reactions, botUserId);

  let displayName = userName;
  try {
    const info = await getUserInfo({ token, userId });
    const profile = info?.user?.profile;
    displayName =
      profile?.display_name?.trim() ||
      profile?.real_name?.trim() ||
      userName;
  } catch (err) {
    console.error('users.info fetch failed', err);
  }

  let weather = null;
  try {
    weather = await fetchWeather(owmKey, {
      timeoutMs: WEATHER_TIMEOUT_MS,
      target: 'now',
    });
  } catch (err) {
    console.error('weather fetch failed', err);
  }

  const headerText = `${editText} (${displayName})`;
  const newBody = formatMessage(roster, weather, { headerText });

  try {
    await updateMessage({ token, channel: channelId, ts, text: newBody });
    return response(200);
  } catch (err) {
    await notifyFailure({
      token,
      error: err,
      context: {
        lambda: 'slashCommand',
        phase: 'chat.update',
        channel: channelId,
        ts,
      },
    });
    return response(500, 'internal error');
  }
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npx vitest run test/slashCommandHandler.test.js`
Expected: PASS — happy-path edit test green, all other tests still green.

- [ ] **Step 6: Commit**

```bash
git add src/slashCommand/handler.js test/slashCommandHandler.test.js
git commit -m "feat(slashCommand): implement /ball edit happy path"
```

---

## Task 8: `/ball edit` — not-found + error-path cases

**Files:**
- Modify: `test/slashCommandHandler.test.js`

- [ ] **Step 1: Write the failing tests**

Append inside `describe('slashCommand handler', ...)`:

```js
  test('`/ball edit` with no bot message in recent history returns an ephemeral error', async () => {
    getChannelHistory.mockResolvedValue({
      ok: true,
      messages: [
        { user: 'U_HUMAN', ts: '3.0', text: 'hi' },
        { user: 'U_OTHER', ts: '2.0', text: 'not a bot' },
      ],
    });

    const res = await handler(
      event({
        command: '/ball',
        text: 'edit 8pm',
        user_id: 'U123',
        user_name: 'alice',
        channel_id: 'C_CURRENT',
      }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.response_type).toBe('ephemeral');
    expect(body.text).toMatch(/no recent/i);
    expect(updateMessage).not.toHaveBeenCalled();
    expect(getReactions).not.toHaveBeenCalled();
  });

  test('`/ball edit` notifies failure and returns 500 when chat.update throws', async () => {
    getChannelHistory.mockResolvedValue({
      ok: true,
      messages: [{ user: 'U_BOT', ts: '2.0', text: '🏀 tonight (Alice)' }],
    });
    getReactions.mockResolvedValue({ ok: true, message: { reactions: [] } });
    fetchWeather.mockResolvedValue(null);
    updateMessage.mockRejectedValue(new Error('slack down'));

    const res = await handler(
      event({
        command: '/ball',
        text: 'edit 8pm',
        user_id: 'U123',
        user_name: 'alice',
        channel_id: 'C_CURRENT',
      }),
    );

    expect(res.statusCode).toBe(500);
    expect(notifyFailure).toHaveBeenCalledTimes(1);
    const ctx = notifyFailure.mock.calls[0][0].context;
    expect(ctx.lambda).toBe('slashCommand');
    expect(ctx.phase).toBe('chat.update');
    expect(ctx.channel).toBe('C_CURRENT');
    expect(ctx.ts).toBe('2.0');
  });

  test('`/ball edit` notifies failure when conversations.history throws', async () => {
    getChannelHistory.mockRejectedValue(new Error('slack down'));

    const res = await handler(
      event({
        command: '/ball',
        text: 'edit 8pm',
        user_id: 'U123',
        user_name: 'alice',
        channel_id: 'C_CURRENT',
      }),
    );

    expect(res.statusCode).toBe(500);
    expect(notifyFailure).toHaveBeenCalledTimes(1);
    expect(notifyFailure.mock.calls[0][0].context.phase).toBe('conversations.history');
    expect(updateMessage).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the tests and verify they pass**

Run: `npx vitest run test/slashCommandHandler.test.js`
Expected: PASS — all three new tests should already pass because the implementation from Task 7 handles these cases. If any fail, the implementation needs the corresponding branch added (do that here before moving on).

- [ ] **Step 3: Commit**

```bash
git add test/slashCommandHandler.test.js
git commit -m "test(slashCommand): cover /ball edit error and not-found paths"
```

---

## Task 9: README updates for new commands and env var

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read the current README**

Run: `cat README.md` to find the slash-command and env-var sections.

- [ ] **Step 2: Update the env-var section**

The `SLACK_CHANNELS` rename should already be in place from Task 4. Verify the line reads:

```
- `SLACK_CHANNELS` — comma-separated list of target channel IDs (default: `C0123456789`). The bot must be invited to each channel.
```

If it doesn't, apply the fix.

- [ ] **Step 3: Add `/ball edit` docs near the existing `/ball` usage**

In the README section that documents `/ball <text>` (search for `"/ball"`), add a paragraph:

```markdown
To fix a typo or change the time after posting, run:

    /ball edit <new message>

This rewrites the most recent bball message in the current channel with the new header text, preserving the current reactions (In/Out/Unsure) and refreshing the weather for "now". It only touches the channel where the command is run — other channels in `SLACK_CHANNELS` are left alone.
```

- [ ] **Step 4: Run the full test suite as a smoke check**

Run: `npx vitest run`
Expected: PASS — every suite green.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document /ball edit and SLACK_CHANNELS"
```

---

## Self-review notes

- Every spec section has a task: fanout (Tasks 1–4), `getChannelHistory` wrapper (Task 5), `/ball edit` parsing + usage (Task 6), happy path (Task 7), error paths (Task 8), docs (Task 9).
- Type/name consistency verified: `parseChannels`, `getChannelHistory`, `handleEdit`, `updateMessage`, `getReactions` used identically across tasks. `SLACK_CHANNELS` is the sole env var everywhere post-Task-4.
- The `channel_id` form field is read via the same `params` URLSearchParams instance already in the handler — no new decoding path.
- `categorize` import path verified against existing `slashCommand → reactionHandler` precedent (`verifySignature`).
- No placeholders, no "TBD", no "add error handling", no "similar to Task N".
