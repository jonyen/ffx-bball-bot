import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/reactionHandler/verifySignature.js', () => ({
  verifySignature: vi.fn(),
}));

vi.mock('../src/postMessage/weather.js', () => ({
  fetchWeather: vi.fn(),
  pickIcon: vi.fn(),
}));

vi.mock('../src/shared/slack.js', () => ({
  postMessage: vi.fn(),
  getUserInfo: vi.fn(),
  notifyFailure: vi.fn(),
  parseChannels: (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  FAILURE_DM_USER: 'U0000000000',
}));

import { handler } from '../src/slashCommand/handler.js';
import { verifySignature } from '../src/reactionHandler/verifySignature.js';
import { fetchWeather } from '../src/postMessage/weather.js';
import { postMessage, getUserInfo, notifyFailure } from '../src/shared/slack.js';

function userInfoResponse({ display_name = '', real_name = '' } = {}) {
  return { ok: true, user: { id: 'U123', name: 'alice', profile: { display_name, real_name } } };
}

function formEncoded(fields) {
  return new URLSearchParams(fields).toString();
}

function event(fields, { signature = 'v0=sig', timestamp = '1' } = {}) {
  return {
    body: formEncoded(fields),
    headers: {
      'x-slack-signature': signature,
      'x-slack-request-timestamp': timestamp,
      'content-type': 'application/x-www-form-urlencoded',
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  process.env.SLACK_SIGNING_SECRET = 'secret';
  process.env.SLACK_CHANNELS = 'C_TEST';
  delete process.env.SLACK_CHANNEL;
  process.env.OPENWEATHERMAP_API_KEY = 'owm-key';
  verifySignature.mockReturnValue(true);
  getUserInfo.mockResolvedValue(userInfoResponse({ display_name: 'Alice' }));
});

describe('slashCommand handler', () => {
  test('returns 401 when signature is invalid', async () => {
    verifySignature.mockReturnValue(false);
    const res = await handler(
      event({
        command: '/ball',
        text: 'tonight at 7pm',
        user_id: 'U123',
        user_name: 'alice',
      }),
    );
    expect(res.statusCode).toBe(401);
    expect(postMessage).not.toHaveBeenCalled();
  });

  test('rejects empty text with an ephemeral usage hint', async () => {
    const res = await handler(
      event({
        command: '/ball',
        text: '',
        user_id: 'U123',
        user_name: 'alice',
      }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.response_type).toBe('ephemeral');
    expect(body.text).toMatch(/usage/i);
    expect(body.text).toContain('/ball');
    expect(postMessage).not.toHaveBeenCalled();
  });

  test('rejects whitespace-only text with the same hint', async () => {
    const res = await handler(
      event({
        command: '/ball',
        text: '   ',
        user_id: 'U123',
        user_name: 'alice',
      }),
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.response_type).toBe('ephemeral');
    expect(postMessage).not.toHaveBeenCalled();
  });

  test('posts a message with custom header, display name attribution, and weather', async () => {
    fetchWeather.mockResolvedValue({
      icon: '☀️',
      tempF: 72,
      description: 'Clear sky',
    });
    postMessage.mockResolvedValue({ ok: true, ts: '1.2' });

    const res = await handler(
      event({
        command: '/ball',
        text: 'tonight at 7pm, outdoor courts',
        user_id: 'U123',
        user_name: 'alice',
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(fetchWeather).toHaveBeenCalledWith('owm-key', {
      timeoutMs: 2000,
      target: 'now',
    });
    expect(getUserInfo).toHaveBeenCalledWith({ token: 'xoxb-test', userId: 'U123' });
    expect(postMessage).toHaveBeenCalledTimes(1);
    const call = postMessage.mock.calls[0][0];
    expect(call.token).toBe('xoxb-test');
    expect(call.channel).toBe('C_TEST');
    expect(call.text).toBe(
      '🏀 tonight at 7pm, outdoor courts (Alice)\n\n──────────────\n☀️ Fairfax, VA — 72°F, Clear sky',
    );
  });

  test('falls back to real_name when display_name is empty', async () => {
    getUserInfo.mockResolvedValue(
      userInfoResponse({ display_name: '', real_name: 'Alice Smith' }),
    );
    fetchWeather.mockResolvedValue(null);
    postMessage.mockResolvedValue({ ok: true, ts: '1.2' });

    await handler(
      event({
        command: '/ball',
        text: '7pm',
        user_id: 'U123',
        user_name: 'alice',
      }),
    );

    expect(postMessage.mock.calls[0][0].text).toBe('🏀 7pm (Alice Smith)');
  });

  test('falls back to slash-command user_name when users.info throws', async () => {
    getUserInfo.mockRejectedValue(new Error('scope missing'));
    fetchWeather.mockResolvedValue(null);
    postMessage.mockResolvedValue({ ok: true, ts: '1.2' });

    await handler(
      event({
        command: '/ball',
        text: '7pm',
        user_id: 'U123',
        user_name: 'alice',
      }),
    );

    expect(postMessage.mock.calls[0][0].text).toBe('🏀 7pm (alice)');
  });

  test('still posts (without weather) when fetchWeather returns null', async () => {
    fetchWeather.mockResolvedValue(null);
    postMessage.mockResolvedValue({ ok: true, ts: '1.2' });

    await handler(
      event({
        command: '/ball',
        text: '6pm Thursday',
        user_id: 'U123',
        user_name: 'alice',
      }),
    );

    const text = postMessage.mock.calls[0][0].text;
    expect(text).toBe('🏀 6pm Thursday (Alice)');
  });

  test('trims leading/trailing whitespace from the command text', async () => {
    fetchWeather.mockResolvedValue(null);
    postMessage.mockResolvedValue({ ok: true, ts: '1.2' });

    await handler(
      event({
        command: '/ball',
        text: '   6pm Thursday   ',
        user_id: 'U123',
        user_name: 'alice',
      }),
    );

    const text = postMessage.mock.calls[0][0].text;
    expect(text).toBe('🏀 6pm Thursday (Alice)');
  });

  test('URL-decodes the form body', async () => {
    fetchWeather.mockResolvedValue(null);
    postMessage.mockResolvedValue({ ok: true, ts: '1.2' });

    // URLSearchParams already handles this, but verify end-to-end
    await handler(
      event({
        command: '/ball',
        text: 'park @ 7pm? bring water',
        user_id: 'U123',
        user_name: 'alice',
      }),
    );

    const text = postMessage.mock.calls[0][0].text;
    expect(text).toBe('🏀 park @ 7pm? bring water (Alice)');
  });

  test('notifies failure and returns 500 when chat.postMessage throws', async () => {
    fetchWeather.mockResolvedValue(null);
    postMessage.mockRejectedValue(new Error('slack down'));

    const res = await handler(
      event({
        command: '/ball',
        text: 'right now',
        user_id: 'U123',
        user_name: 'alice',
      }),
    );

    expect(res.statusCode).toBe(500);
    expect(notifyFailure).toHaveBeenCalledTimes(1);
    const ctx = notifyFailure.mock.calls[0][0];
    expect(ctx.context.lambda).toBe('slashCommand');
    expect(ctx.context.user).toBe('U123');
  });

  test('handles base64-encoded body from API Gateway', async () => {
    fetchWeather.mockResolvedValue(null);
    postMessage.mockResolvedValue({ ok: true, ts: '1.2' });

    const raw = formEncoded({
      command: '/ball',
      text: 'right now',
      user_id: 'U123',
      user_name: 'alice',
    });
    const b64 = Buffer.from(raw, 'utf-8').toString('base64');

    await handler({
      body: b64,
      isBase64Encoded: true,
      headers: {
        'x-slack-signature': 'v0=sig',
        'x-slack-request-timestamp': '1',
        'content-type': 'application/x-www-form-urlencoded',
      },
    });

    const text = postMessage.mock.calls[0][0].text;
    expect(text).toBe('🏀 right now (Alice)');
  });

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

  test('returns 200 and no-ops when SLACK_CHANNELS is empty', async () => {
    process.env.SLACK_CHANNELS = '';
    fetchWeather.mockResolvedValue(null);

    const res = await handler(
      event({ command: '/ball', text: '7pm', user_id: 'U123', user_name: 'alice' }),
    );

    expect(res.statusCode).toBe(200);
    expect(postMessage).not.toHaveBeenCalled();
    expect(notifyFailure).not.toHaveBeenCalled();
  });
});
