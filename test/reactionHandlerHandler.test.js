import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/reactionHandler/verifySignature.js', () => ({
  verifySignature: vi.fn(),
}));

vi.mock('../src/shared/slack.js', () => ({
  updateMessage: vi.fn(),
  getHistory: vi.fn(),
  getReactions: vi.fn(),
  notifyFailure: vi.fn(),
  FAILURE_DM_USER: 'U0000000000',
}));

import { handler } from '../src/reactionHandler/handler.js';
import { verifySignature } from '../src/reactionHandler/verifySignature.js';
import {
  updateMessage,
  getHistory,
  getReactions,
  notifyFailure,
} from '../src/shared/slack.js';

const BOT = 'UBOT';

function event(body, { signature = 'v0=sig', timestamp = '1' } = {}) {
  return {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: {
      'x-slack-signature': signature,
      'x-slack-request-timestamp': timestamp,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  process.env.SLACK_SIGNING_SECRET = 'secret';
  process.env.SLACK_BOT_USER_ID = BOT;
  verifySignature.mockReturnValue(true);
});

describe('reactionHandler', () => {
  test('returns 401 when signature is invalid', async () => {
    verifySignature.mockReturnValue(false);
    const res = await handler(event({ type: 'event_callback' }));
    expect(res.statusCode).toBe(401);
  });

  test('echoes the challenge for url_verification', async () => {
    const res = await handler(
      event({ type: 'url_verification', challenge: 'abc123' }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('abc123');
  });

  test('returns 200 and no-ops for non-reaction event types', async () => {
    const res = await handler(
      event({ type: 'event_callback', event: { type: 'message' } }),
    );
    expect(res.statusCode).toBe(200);
    expect(getHistory).not.toHaveBeenCalled();
    expect(updateMessage).not.toHaveBeenCalled();
  });

  test('returns 200 no-op when reacted message is not from the bot', async () => {
    getHistory.mockResolvedValue({
      messages: [{ user: 'USOMEONE_ELSE', text: '🏀 today?', ts: '1.2' }],
    });

    const res = await handler(
      event({
        type: 'event_callback',
        event: {
          type: 'reaction_added',
          item: { channel: 'C1', ts: '1.2' },
        },
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(updateMessage).not.toHaveBeenCalled();
  });

  test('rebuilds and updates the message on reaction_added', async () => {
    getHistory.mockResolvedValue({
      messages: [
        {
          user: BOT,
          text: '🏀 today?\n\n──────────────\n☀️ Fairfax, VA — 72°F, Clear sky',
          ts: '1.2',
        },
      ],
    });
    getReactions.mockResolvedValue({
      message: {
        reactions: [
          { name: 'basketball', users: ['U1', 'U2'] },
          { name: 'x', users: ['U3'] },
        ],
      },
    });
    updateMessage.mockResolvedValue({ ok: true });

    const res = await handler(
      event({
        type: 'event_callback',
        event: {
          type: 'reaction_added',
          item: { channel: 'C1', ts: '1.2' },
        },
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(updateMessage).toHaveBeenCalledTimes(1);
    const call = updateMessage.mock.calls[0][0];
    expect(call.channel).toBe('C1');
    expect(call.ts).toBe('1.2');
    expect(call.text).toContain('In (2): <@U1>, <@U2>');
    expect(call.text).toContain('Out: <@U3>');
    expect(call.text).toContain('☀️ Fairfax, VA — 72°F, Clear sky');
  });

  test('treats reaction_removed the same as reaction_added', async () => {
    getHistory.mockResolvedValue({
      messages: [{ user: BOT, text: '🏀 today?', ts: '1.2' }],
    });
    getReactions.mockResolvedValue({ message: { reactions: [] } });
    updateMessage.mockResolvedValue({ ok: true });

    const res = await handler(
      event({
        type: 'event_callback',
        event: {
          type: 'reaction_removed',
          item: { channel: 'C1', ts: '1.2' },
        },
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(updateMessage).toHaveBeenCalledTimes(1);
  });

  test('notifies failure and returns 500 on unexpected error', async () => {
    getHistory.mockRejectedValue(new Error('slack hiccup'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await handler(
      event({
        type: 'event_callback',
        event: {
          type: 'reaction_added',
          item: { channel: 'C1', ts: '1.2' },
        },
      }),
    );

    expect(res.statusCode).toBe(500);
    expect(notifyFailure).toHaveBeenCalledTimes(1);
    const ctx = notifyFailure.mock.calls[0][0];
    expect(ctx.context.lambda).toBe('reactionHandler');
    errSpy.mockRestore();
  });

  test('preserves a custom slash-command header when rebuilding on reaction', async () => {
    getHistory.mockResolvedValue({
      messages: [
        {
          user: BOT,
          text:
            '🏀 tonight at 7pm? — <@U123>\n\n──────────────\n☀️ Fairfax, VA — 72°F, Clear sky',
          ts: '1.2',
        },
      ],
    });
    getReactions.mockResolvedValue({
      message: {
        reactions: [{ name: 'basketball', users: ['U1'] }],
      },
    });
    updateMessage.mockResolvedValue({ ok: true });

    await handler(
      event({
        type: 'event_callback',
        event: {
          type: 'reaction_added',
          item: { channel: 'C1', ts: '1.2' },
        },
      }),
    );

    const text = updateMessage.mock.calls[0][0].text;
    expect(text).toContain('🏀 tonight at 7pm? — <@U123>');
    expect(text).toContain('In (1): <@U1>');
    expect(text).toContain('☀️ Fairfax, VA — 72°F, Clear sky');
    expect(text).not.toContain('🏀 today?');
  });

  test('filters out the bot user from the computed roster', async () => {
    getHistory.mockResolvedValue({
      messages: [{ user: BOT, text: '🏀 today?', ts: '1.2' }],
    });
    getReactions.mockResolvedValue({
      message: {
        reactions: [{ name: 'basketball', users: [BOT, 'U1'] }],
      },
    });
    updateMessage.mockResolvedValue({ ok: true });

    await handler(
      event({
        type: 'event_callback',
        event: {
          type: 'reaction_added',
          item: { channel: 'C1', ts: '1.2' },
        },
      }),
    );

    const text = updateMessage.mock.calls[0][0].text;
    expect(text).toContain('<@U1>');
    expect(text).not.toContain(`<@${BOT}>`);
  });
});
