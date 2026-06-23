import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/shared/weatherResolver.js', () => ({
  resolveWeather: vi.fn(),
}));

vi.mock('../src/shared/slack.js', () => ({
  getReactions: vi.fn(),
  updateMessage: vi.fn(),
  notifyFailure: vi.fn(),
  parseChannels: (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean),
}));

import { handler } from '../src/slashCommand/weatherEdit.js';
import { resolveWeather } from '../src/shared/weatherResolver.js';
import { getReactions, updateMessage, notifyFailure } from '../src/shared/slack.js';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  process.env.SLACK_BOT_USER_ID = 'U_BOT';
  process.env.SLACK_CHANNELS = 'C_ONE,C_TWO';
});

describe('weatherEdit worker', () => {
  test('edits the weather line into the message, preserving roster and header', async () => {
    getReactions.mockResolvedValue({
      ok: true,
      message: {
        text: '🏀 tonight at 7pm (Alice)\n\nIn (1): <@U_HUMAN>',
        reactions: [{ name: 'basketball', users: ['U_HUMAN'], count: 1 }],
      },
    });
    resolveWeather.mockResolvedValue({ icon: '☀️', tempF: 70, description: 'Clear sky' });
    updateMessage.mockResolvedValue({ ok: true });

    await handler({ channel: 'C_CURRENT', ts: '2.0' });

    expect(getReactions).toHaveBeenCalledWith({
      token: 'xoxb-test',
      channel: 'C_CURRENT',
      ts: '2.0',
    });
    expect(resolveWeather).toHaveBeenCalledWith({
      token: 'xoxb-test',
      channels: ['C_ONE', 'C_TWO'],
      botUserId: 'U_BOT',
      target: 'now',
    });
    expect(updateMessage).toHaveBeenCalledTimes(1);
    expect(updateMessage.mock.calls[0][0].text).toBe(
      '🏀 tonight at 7pm (Alice)\n\nIn (1): <@U_HUMAN>\n\n──────────────\n☀️ Fairfax, VA — 70°F, Clear sky',
    );
  });

  test('leaves the message untouched when no weather is available', async () => {
    getReactions.mockResolvedValue({
      ok: true,
      message: { text: '🏀 tonight (Alice)', reactions: [] },
    });
    resolveWeather.mockResolvedValue(null);

    await handler({ channel: 'C_CURRENT', ts: '2.0' });

    expect(updateMessage).not.toHaveBeenCalled();
    expect(notifyFailure).not.toHaveBeenCalled();
  });

  test('no-ops without channel/ts', async () => {
    await handler({ channel: 'C_CURRENT' });
    await handler({ ts: '2.0' });
    await handler(undefined);

    expect(getReactions).not.toHaveBeenCalled();
    expect(resolveWeather).not.toHaveBeenCalled();
    expect(updateMessage).not.toHaveBeenCalled();
  });

  test('notifies and bails when reactions.get throws', async () => {
    getReactions.mockRejectedValue(new Error('slack down'));

    await handler({ channel: 'C_CURRENT', ts: '2.0' });

    expect(resolveWeather).not.toHaveBeenCalled();
    expect(updateMessage).not.toHaveBeenCalled();
    expect(notifyFailure).toHaveBeenCalledTimes(1);
    expect(notifyFailure.mock.calls[0][0].context.phase).toBe('reactions.get');
  });

  test('notifies when chat.update throws', async () => {
    getReactions.mockResolvedValue({ ok: true, message: { text: '🏀 x (Alice)', reactions: [] } });
    resolveWeather.mockResolvedValue({ icon: '☀️', tempF: 70, description: 'Clear sky' });
    updateMessage.mockRejectedValue(new Error('slack down'));

    await handler({ channel: 'C_CURRENT', ts: '2.0' });

    expect(notifyFailure).toHaveBeenCalledTimes(1);
    expect(notifyFailure.mock.calls[0][0].context.phase).toBe('chat.update');
  });
});
