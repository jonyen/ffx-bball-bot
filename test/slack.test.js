import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  postMessage,
  updateMessage,
  getHistory,
  getReactions,
  notifyFailure,
  FAILURE_DM_USER,
} from '../src/shared/slack.js';

const TOKEN = 'xoxb-test';
const ORIGINAL_FETCH = globalThis.fetch;

function slackOk(body = {}) {
  return {
    ok: true,
    json: async () => ({ ok: true, ...body }),
  };
}

function slackErr(errorCode) {
  return {
    ok: true,
    json: async () => ({ ok: false, error: errorCode }),
  };
}

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe('postMessage', () => {
  test('POSTs to chat.postMessage with bearer token and JSON body', async () => {
    globalThis.fetch.mockResolvedValue(slackOk({ ts: '1234.5678', channel: 'C1' }));

    const result = await postMessage({
      token: TOKEN,
      channel: 'C1',
      text: 'hello',
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect(init.headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(init.body)).toEqual({ channel: 'C1', text: 'hello' });
    expect(result).toEqual({ ok: true, ts: '1234.5678', channel: 'C1' });
  });

  test('throws when Slack returns ok:false', async () => {
    globalThis.fetch.mockResolvedValue(slackErr('channel_not_found'));
    await expect(
      postMessage({ token: TOKEN, channel: 'C1', text: 'hi' }),
    ).rejects.toThrow(/channel_not_found/);
  });

  test('throws on non-2xx HTTP status', async () => {
    globalThis.fetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    await expect(
      postMessage({ token: TOKEN, channel: 'C1', text: 'hi' }),
    ).rejects.toThrow(/500/);
  });
});

describe('updateMessage', () => {
  test('POSTs to chat.update with channel, ts, and text', async () => {
    globalThis.fetch.mockResolvedValue(slackOk());
    await updateMessage({ token: TOKEN, channel: 'C1', ts: '1.2', text: 'new' });

    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://slack.com/api/chat.update');
    expect(JSON.parse(init.body)).toEqual({ channel: 'C1', ts: '1.2', text: 'new' });
  });
});

describe('getHistory', () => {
  test('calls conversations.history with channel, latest, limit=1, inclusive=true', async () => {
    globalThis.fetch.mockResolvedValue(
      slackOk({ messages: [{ user: 'UBOT', text: 'hi', ts: '1.2' }] }),
    );

    const result = await getHistory({ token: TOKEN, channel: 'C1', ts: '1.2' });

    const [url] = globalThis.fetch.mock.calls[0];
    expect(url).toContain('https://slack.com/api/conversations.history');
    expect(url).toContain('channel=C1');
    expect(url).toContain('latest=1.2');
    expect(url).toContain('inclusive=true');
    expect(url).toContain('limit=1');
    expect(result.messages[0]).toEqual({ user: 'UBOT', text: 'hi', ts: '1.2' });
  });
});

describe('getReactions', () => {
  test('calls reactions.get with channel and timestamp', async () => {
    globalThis.fetch.mockResolvedValue(
      slackOk({ message: { reactions: [{ name: 'basketball', users: ['U1'] }] } }),
    );

    const result = await getReactions({ token: TOKEN, channel: 'C1', ts: '1.2' });

    const [url] = globalThis.fetch.mock.calls[0];
    expect(url).toContain('https://slack.com/api/reactions.get');
    expect(url).toContain('channel=C1');
    expect(url).toContain('timestamp=1.2');
    expect(result.message.reactions[0].name).toBe('basketball');
  });

  test('returns empty reactions when message has none', async () => {
    globalThis.fetch.mockResolvedValue(slackOk({ message: {} }));
    const result = await getReactions({ token: TOKEN, channel: 'C1', ts: '1.2' });
    expect(result.message).toEqual({});
  });
});

describe('notifyFailure', () => {
  test('exposes the target user id as a constant', () => {
    expect(FAILURE_DM_USER).toBe('U0000000000');
  });

  test('DMs the failure user with error + context', async () => {
    globalThis.fetch.mockResolvedValue(slackOk());
    const err = new Error('weather api blew up');

    await notifyFailure({
      token: TOKEN,
      error: err,
      context: { lambda: 'postMessage', phase: 'fetch-weather' },
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    const body = JSON.parse(init.body);
    expect(body.channel).toBe('U0000000000');
    expect(body.text).toContain('weather api blew up');
    expect(body.text).toContain('postMessage');
    expect(body.text).toContain('fetch-weather');
  });

  test('swallows errors from the DM attempt itself (never throws)', async () => {
    globalThis.fetch.mockRejectedValue(new Error('slack is down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      notifyFailure({ token: TOKEN, error: new Error('root'), context: {} }),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test('swallows Slack API errors from the DM attempt', async () => {
    globalThis.fetch.mockResolvedValue(slackErr('ratelimited'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      notifyFailure({ token: TOKEN, error: new Error('root'), context: {} }),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test('accepts a non-Error value as error', async () => {
    globalThis.fetch.mockResolvedValue(slackOk());
    await notifyFailure({ token: TOKEN, error: 'plain string failure', context: {} });
    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.text).toContain('plain string failure');
  });
});
