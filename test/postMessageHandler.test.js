import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/postMessage/weather.js', () => ({
  fetchWeather: vi.fn(),
  pickIcon: vi.fn(),
}));

vi.mock('../src/shared/slack.js', () => ({
  postMessage: vi.fn(),
  notifyFailure: vi.fn(),
  parseChannels: (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  FAILURE_DM_USER: 'U0000000000',
}));

import { handler } from '../src/postMessage/handler.js';
import { fetchWeather } from '../src/postMessage/weather.js';
import { postMessage, notifyFailure } from '../src/shared/slack.js';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  process.env.SLACK_CHANNELS = 'C_TEST';
  delete process.env.SLACK_CHANNEL;
});

describe('postMessage handler', () => {
  test('fetches weather, formats, and posts to the configured channel', async () => {
    fetchWeather.mockResolvedValue({ icon: '☀️', tempF: 72, description: 'Clear sky' });
    postMessage.mockResolvedValue({ ok: true, ts: '1.2' });

    await handler({});

    expect(fetchWeather).toHaveBeenCalledWith();
    expect(postMessage).toHaveBeenCalledTimes(1);
    const call = postMessage.mock.calls[0][0];
    expect(call.token).toBe('xoxb-test');
    expect(call.channel).toBe('C_TEST');
    expect(call.text).toContain('🏀 today?');
    expect(call.text).toContain('72°F');
    expect(notifyFailure).not.toHaveBeenCalled();
  });

  test('posts without a weather line when fetchWeather returns null', async () => {
    fetchWeather.mockResolvedValue(null);
    postMessage.mockResolvedValue({ ok: true, ts: '1.2' });

    await handler({});

    const text = postMessage.mock.calls[0][0].text;
    expect(text).toBe('🏀 today?');
    expect(notifyFailure).not.toHaveBeenCalled();
  });

  test('notifies failure and rethrows when chat.postMessage throws', async () => {
    fetchWeather.mockResolvedValue({ icon: '☀️', tempF: 72, description: 'Clear sky' });
    const boom = new Error('slack down');
    postMessage.mockRejectedValue(boom);

    await expect(handler({})).rejects.toThrow('slack down');

    expect(notifyFailure).toHaveBeenCalledTimes(1);
    const ctx = notifyFailure.mock.calls[0][0];
    expect(ctx.error).toBe(boom);
    expect(ctx.context.lambda).toBe('postMessage');
    expect(ctx.token).toBe('xoxb-test');
  });

  test('weather fetch throwing does not block the post; still posts without weather', async () => {
    fetchWeather.mockRejectedValue(new Error('owm down'));
    postMessage.mockResolvedValue({ ok: true, ts: '1.2' });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await handler({});

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0].text).toBe('🏀 today?');
    errSpy.mockRestore();
  });

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
});
