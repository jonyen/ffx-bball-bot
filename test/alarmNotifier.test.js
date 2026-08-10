import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/shared/slack.js', () => ({
  postMessage: vi.fn(),
}));

import { handler } from '../src/alarmNotifier/handler.js';
import { postMessage } from '../src/shared/slack.js';

function snsEvent(alarm) {
  return { Records: [{ Sns: { Message: JSON.stringify(alarm) } }] };
}

const ALARM = {
  AlarmName: 'ffx-bball-roll-call-missing',
  AlarmDescription: 'No roll call posted in the expected window',
  NewStateValue: 'ALARM',
  OldStateValue: 'OK',
  NewStateReason: 'Threshold Crossed: no datapoints were received.',
  Region: 'US East (N. Virginia)',
  Trigger: { MetricName: 'RollCallPosted', Namespace: 'FfxBballBot' },
};

describe('alarm notifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.ALARM_CHANNEL = 'C_ALARMS';
  });

  test('posts the alarm to the alarm channel', async () => {
    await handler(snsEvent(ALARM));

    expect(postMessage).toHaveBeenCalledTimes(1);
    const arg = postMessage.mock.calls[0][0];
    expect(arg.channel).toBe('C_ALARMS');
    expect(arg.text).toContain('ffx-bball-roll-call-missing');
    expect(arg.text).toContain('No roll call posted in the expected window');
  });

  test('marks firing alarms distinctly from recoveries', async () => {
    await handler(snsEvent(ALARM));
    expect(postMessage.mock.calls[0][0].text).toContain('🔴');

    vi.clearAllMocks();
    await handler(snsEvent({ ...ALARM, NewStateValue: 'OK', OldStateValue: 'ALARM' }));
    expect(postMessage.mock.calls[0][0].text).toContain('✅');
  });

  test('includes the reason so the channel shows why without a console trip', async () => {
    await handler(snsEvent(ALARM));
    expect(postMessage.mock.calls[0][0].text).toContain('no datapoints were received');
  });

  test('handles several records in one delivery', async () => {
    await handler({
      Records: [
        { Sns: { Message: JSON.stringify(ALARM) } },
        { Sns: { Message: JSON.stringify({ ...ALARM, AlarmName: 'second' }) } },
      ],
    });
    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  test('falls back to raw text when the payload is not alarm JSON', async () => {
    await handler({ Records: [{ Sns: { Message: 'plain string alert' } }] });

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0].text).toContain('plain string alert');
  });

  test('logs instead of posting when no alarm channel is configured', async () => {
    delete process.env.ALARM_CHANNEL;
    await expect(handler(snsEvent(ALARM))).resolves.not.toThrow();
    expect(postMessage).not.toHaveBeenCalled();
  });

  test('never throws when Slack is the thing that is down', async () => {
    postMessage.mockRejectedValueOnce(new Error('slack unreachable'));
    await expect(handler(snsEvent(ALARM))).resolves.not.toThrow();
  });

  test('one failed record does not suppress the rest', async () => {
    postMessage.mockRejectedValueOnce(new Error('transient'));
    await handler({
      Records: [
        { Sns: { Message: JSON.stringify(ALARM) } },
        { Sns: { Message: JSON.stringify({ ...ALARM, AlarmName: 'second' }) } },
      ],
    });
    expect(postMessage).toHaveBeenCalledTimes(2);
  });
});
