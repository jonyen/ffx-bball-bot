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
  getChannelHistory: vi.fn(),
  getReactions: vi.fn(),
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),
  FAILURE_DM_USER: 'U0000000000',
}));

vi.mock('../src/shared/scheduler.js', () => ({
  getSchedule: vi.fn(),
  updateSchedule: vi.fn(),
}));

vi.mock('../src/shared/invokeLambda.js', () => ({
  invokeAsync: vi.fn(),
}));

// scheduleParser is pure JS with no AWS SDK deps — use the real implementation
// so handler tests exercise the same parser that runs in production.

import { handler } from '../src/slashCommand/handler.js';
import { verifySignature } from '../src/reactionHandler/verifySignature.js';
import { fetchWeather } from '../src/postMessage/weather.js';
import {
  postMessage,
  getUserInfo,
  notifyFailure,
  getChannelHistory,
  getReactions,
  updateMessage,
  deleteMessage,
} from '../src/shared/slack.js';
import { parseMessageRef } from '../src/slashCommand/handler.js';
import { getSchedule, updateSchedule } from '../src/shared/scheduler.js';
import { invokeAsync } from '../src/shared/invokeLambda.js';

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
  process.env.SLACK_BOT_USER_ID = 'U_BOT';
  process.env.SCHEDULE_NAME = 'ffx-bball-post-schedule';
  process.env.SCHEDULE_GROUP = 'default';
  process.env.WEATHER_EDIT_FUNCTION = 'ffx-bball-weather-edit';
  verifySignature.mockReturnValue(true);
  getUserInfo.mockResolvedValue(userInfoResponse({ display_name: 'Alice' }));
  invokeAsync.mockResolvedValue({});
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
        channel_id: 'C_CURRENT',
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
        channel_id: 'C_CURRENT',
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
        channel_id: 'C_CURRENT',
      }),
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.response_type).toBe('ephemeral');
    expect(postMessage).not.toHaveBeenCalled();
  });

  test('posts a weather-less message immediately and fires the async weather-edit worker', async () => {
    postMessage.mockResolvedValue({ ok: true, ts: '1.2', channel: 'C_CURRENT' });

    const res = await handler(
      event({
        command: '/ball',
        text: 'tonight at 7pm, outdoor courts',
        user_id: 'U123',
        user_name: 'alice',
        channel_id: 'C_CURRENT',
      }),
    );

    expect(res.statusCode).toBe(200);
    // Weather is NOT fetched synchronously — that's what blew the 3s deadline.
    expect(fetchWeather).not.toHaveBeenCalled();
    expect(getUserInfo).toHaveBeenCalledWith({ token: 'xoxb-test', userId: 'U123' });
    expect(postMessage).toHaveBeenCalledTimes(1);
    const call = postMessage.mock.calls[0][0];
    expect(call.token).toBe('xoxb-test');
    expect(call.channel).toBe('C_CURRENT');
    // No weather line — the worker adds it later.
    expect(call.text).toBe('tonight at 7pm, outdoor courts (Alice)');

    // Worker invoked with the posted message's channel + ts.
    expect(invokeAsync).toHaveBeenCalledTimes(1);
    expect(invokeAsync).toHaveBeenCalledWith({
      functionName: 'ffx-bball-weather-edit',
      payload: { channel: 'C_CURRENT', ts: '1.2' },
    });
  });

  test('post path still returns 200 when the worker invoke fails', async () => {
    postMessage.mockResolvedValue({ ok: true, ts: '1.2', channel: 'C_CURRENT' });
    invokeAsync.mockRejectedValue(new Error('lambda throttled'));

    const res = await handler(
      event({
        command: '/ball',
        text: '7pm',
        user_id: 'U123',
        user_name: 'alice',
        channel_id: 'C_CURRENT',
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(notifyFailure).not.toHaveBeenCalled();
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
        channel_id: 'C_CURRENT',
      }),
    );

    expect(postMessage.mock.calls[0][0].text).toBe('7pm (Alice Smith)');
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
        channel_id: 'C_CURRENT',
      }),
    );

    expect(postMessage.mock.calls[0][0].text).toBe('7pm (alice)');
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
        channel_id: 'C_CURRENT',
      }),
    );

    const text = postMessage.mock.calls[0][0].text;
    expect(text).toBe('6pm Thursday (Alice)');
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
        channel_id: 'C_CURRENT',
      }),
    );

    const text = postMessage.mock.calls[0][0].text;
    expect(text).toBe('6pm Thursday (Alice)');
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
        channel_id: 'C_CURRENT',
      }),
    );

    const text = postMessage.mock.calls[0][0].text;
    expect(text).toBe('park @ 7pm? bring water (Alice)');
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
        channel_id: 'C_CURRENT',
      }),
    );

    expect(res.statusCode).toBe(500);
    expect(notifyFailure).toHaveBeenCalledTimes(1);
    const ctx = notifyFailure.mock.calls[0][0];
    expect(ctx.context.lambda).toBe('slashCommand');
    expect(ctx.context.user).toBe('U123');
    expect(ctx.context.channel).toBe('C_CURRENT');
  });

  test('handles base64-encoded body from API Gateway', async () => {
    fetchWeather.mockResolvedValue(null);
    postMessage.mockResolvedValue({ ok: true, ts: '1.2' });

    const raw = formEncoded({
      command: '/ball',
      text: 'right now',
      user_id: 'U123',
      user_name: 'alice',
      channel_id: 'C_CURRENT',
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
    expect(text).toBe('right now (Alice)');
  });

  test('only posts to the invoking channel, ignoring SLACK_CHANNELS fanout', async () => {
    process.env.SLACK_CHANNELS = 'C_ONE,C_TWO';
    fetchWeather.mockResolvedValue(null);
    postMessage.mockResolvedValue({ ok: true, ts: '1.2' });

    const res = await handler(
      event({
        command: '/ball',
        text: '7pm',
        user_id: 'U123',
        user_name: 'alice',
        channel_id: 'C_CURRENT',
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0].channel).toBe('C_CURRENT');
    expect(notifyFailure).not.toHaveBeenCalled();
  });

  test('returns ephemeral error when channel_id is missing', async () => {
    const res = await handler(
      event({
        command: '/ball',
        text: '7pm',
        user_id: 'U123',
        user_name: 'alice',
      }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.response_type).toBe('ephemeral');
    expect(body.text).toMatch(/channel/i);
    expect(postMessage).not.toHaveBeenCalled();
  });

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

  test('`/ball edit <text>` updates the message (weather-less) and fires the weather-edit worker', async () => {
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

    // Weather is NOT fetched synchronously.
    expect(fetchWeather).not.toHaveBeenCalled();

    // chat.update called exactly once, only on the origin channel, with the
    // preserved roster but no weather line yet.
    expect(updateMessage).toHaveBeenCalledTimes(1);
    const call = updateMessage.mock.calls[0][0];
    expect(call.channel).toBe('C_CURRENT');
    expect(call.ts).toBe('2.0');
    expect(call.text).toBe('8pm instead (Alice)\n\nIn (1): <@U_HUMAN>');

    // Worker invoked to fill in weather on the edited message.
    expect(invokeAsync).toHaveBeenCalledWith({
      functionName: 'ffx-bball-weather-edit',
      payload: { channel: 'C_CURRENT', ts: '2.0' },
    });

    // Create-flow side effects never fire.
    expect(postMessage).not.toHaveBeenCalled();
    expect(notifyFailure).not.toHaveBeenCalled();
  });

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
    expect(ctx.user).toBe('U123');
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
    expect(notifyFailure.mock.calls[0][0].context.user).toBe('U123');
    expect(updateMessage).not.toHaveBeenCalled();
  });

  test('`/ball edit` notifies failure and returns 500 when reactions.get throws', async () => {
    getChannelHistory.mockResolvedValue({
      ok: true,
      messages: [{ user: 'U_BOT', ts: '2.0', text: '🏀 tonight (Alice)' }],
    });
    getReactions.mockRejectedValue(new Error('slack down'));

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
    expect(notifyFailure.mock.calls[0][0].context.phase).toBe('reactions.get');
    expect(notifyFailure.mock.calls[0][0].context.user).toBe('U123');
    expect(updateMessage).not.toHaveBeenCalled();
  });

  describe('/ball schedule', () => {
    const currentSchedule = {
      Name: 'ffx-bball-post-schedule',
      GroupName: 'default',
      ScheduleExpression: 'cron(0 8 ? * TUE,THU *)',
      ScheduleExpressionTimezone: 'America/New_York',
      State: 'ENABLED',
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: {
        Arn: 'arn:aws:lambda:us-east-1:123:function:ffx-bball-post-message',
        RoleArn: 'arn:aws:iam::123:role/PostScheduleRole',
      },
    };

    test('`/ball schedule` (no args) shows the current schedule ephemerally', async () => {
      getSchedule.mockResolvedValue(currentSchedule);

      const res = await handler(
        event({
          command: '/ball',
          text: 'schedule',
          user_id: 'U123',
          user_name: 'alice',
          channel_id: 'C_CURRENT',
        }),
      );

      expect(res.statusCode).toBe(200);
      expect(getSchedule).toHaveBeenCalledWith({
        name: 'ffx-bball-post-schedule',
        groupName: 'default',
      });
      expect(updateSchedule).not.toHaveBeenCalled();
      expect(postMessage).not.toHaveBeenCalled();

      const body = JSON.parse(res.body);
      expect(body.response_type).toBe('ephemeral');
      expect(body.text).toContain('cron(0 8 ? * TUE,THU *)');
      expect(body.text).toContain('America/New_York');
      expect(body.text).toContain('ENABLED');
      expect(body.text).toContain('ffx-bball-post-schedule');
    });

    test('`/ball schedule <natural>` calls updateSchedule with preserved fields', async () => {
      getSchedule.mockResolvedValue(currentSchedule);
      updateSchedule.mockResolvedValue({});

      const res = await handler(
        event({
          command: '/ball',
          text: 'schedule every mon,wed,fri at 7am',
          user_id: 'U123',
          user_name: 'alice',
          channel_id: 'C_CURRENT',
        }),
      );

      expect(res.statusCode).toBe(200);
      expect(updateSchedule).toHaveBeenCalledTimes(1);
      const call = updateSchedule.mock.calls[0][0];
      expect(call.name).toBe('ffx-bball-post-schedule');
      expect(call.groupName).toBe('default');
      expect(call.scheduleExpression).toBe('cron(0 7 ? * MON,WED,FRI *)');
      expect(call.scheduleExpressionTimezone).toBe('America/New_York');
      expect(call.flexibleTimeWindow).toEqual({ Mode: 'OFF' });
      expect(call.target).toEqual(currentSchedule.Target);
      expect(call.state).toBe('ENABLED');

      const body = JSON.parse(res.body);
      expect(body.response_type).toBe('ephemeral');
      expect(body.text).toMatch(/updated/i);
      expect(body.text).toContain('cron(0 7 ? * MON,WED,FRI *)');
    });

    test('`/ball schedule cron(...)` is rejected (raw expressions no longer supported)', async () => {
      getSchedule.mockResolvedValue(currentSchedule);

      const res = await handler(
        event({
          command: '/ball',
          text: 'schedule cron(30 17 ? * FRI *)',
          user_id: 'U123',
          user_name: 'alice',
          channel_id: 'C_CURRENT',
        }),
      );

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.response_type).toBe('ephemeral');
      expect(body.text).toMatch(/couldn't parse/i);
      expect(updateSchedule).not.toHaveBeenCalled();
    });

    test('`/ball schedule` returns ephemeral error and notifies when getSchedule throws', async () => {
      getSchedule.mockRejectedValue(new Error('AccessDenied'));

      const res = await handler(
        event({
          command: '/ball',
          text: 'schedule',
          user_id: 'U123',
          user_name: 'alice',
          channel_id: 'C_CURRENT',
        }),
      );

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.response_type).toBe('ephemeral');
      expect(body.text).toMatch(/couldn't fetch schedule/i);
      expect(body.text).toContain('AccessDenied');

      expect(notifyFailure).toHaveBeenCalledTimes(1);
      const ctx = notifyFailure.mock.calls[0][0].context;
      expect(ctx.lambda).toBe('slashCommand');
      expect(ctx.phase).toBe('scheduler.getSchedule');
      expect(ctx.user).toBe('U123');
      expect(updateSchedule).not.toHaveBeenCalled();
    });

    test('`/ball schedule <natural>` returns ephemeral error and notifies when updateSchedule throws', async () => {
      getSchedule.mockResolvedValue(currentSchedule);
      updateSchedule.mockRejectedValue(new Error('ValidationException: bad cron'));

      const res = await handler(
        event({
          command: '/ball',
          text: 'schedule every fri at 5pm',
          user_id: 'U123',
          user_name: 'alice',
          channel_id: 'C_CURRENT',
        }),
      );

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.response_type).toBe('ephemeral');
      expect(body.text).toMatch(/schedule update failed/i);
      expect(body.text).toContain('ValidationException');

      expect(notifyFailure).toHaveBeenCalledTimes(1);
      const ctx = notifyFailure.mock.calls[0][0].context;
      expect(ctx.phase).toBe('scheduler.updateSchedule');
      expect(ctx.scheduleExpression).toBe('cron(0 17 ? * FRI *)');
      expect(ctx.user).toBe('U123');
    });

    test('`/ball schedule` with SCHEDULE_NAME unset returns an ephemeral config error', async () => {
      delete process.env.SCHEDULE_NAME;

      const res = await handler(
        event({
          command: '/ball',
          text: 'schedule',
          user_id: 'U123',
          user_name: 'alice',
          channel_id: 'C_CURRENT',
        }),
      );

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.response_type).toBe('ephemeral');
      expect(body.text).toMatch(/SCHEDULE_NAME/);
      expect(getSchedule).not.toHaveBeenCalled();
      expect(updateSchedule).not.toHaveBeenCalled();
    });

    test('`/ball schedule   ` (whitespace-only args) is treated as view', async () => {
      getSchedule.mockResolvedValue(currentSchedule);

      const res = await handler(
        event({
          command: '/ball',
          text: 'schedule   ',
          user_id: 'U123',
          user_name: 'alice',
          channel_id: 'C_CURRENT',
        }),
      );

      expect(res.statusCode).toBe(200);
      expect(getSchedule).toHaveBeenCalledTimes(1);
      expect(updateSchedule).not.toHaveBeenCalled();
    });

    test('`/ball schedule every Tue, Thu at 8am` parses NL and shows interpretation', async () => {
      getSchedule.mockResolvedValue(currentSchedule);
      updateSchedule.mockResolvedValue({});

      const res = await handler(
        event({
          command: '/ball',
          text: 'schedule every Tue, Thu at 8am',
          user_id: 'U123',
          user_name: 'alice',
          channel_id: 'C_CURRENT',
        }),
      );

      expect(res.statusCode).toBe(200);
      expect(updateSchedule).toHaveBeenCalledTimes(1);
      expect(updateSchedule.mock.calls[0][0].scheduleExpression).toBe(
        'cron(0 8 ? * TUE,THU *)',
      );

      const body = JSON.parse(res.body);
      expect(body.response_type).toBe('ephemeral');
      expect(body.text).toContain('cron(0 8 ? * TUE,THU *)');
      expect(body.text).toMatch(/interpreted as/i);
      expect(body.text).toContain('every TUE, THU at 8am');
      expect(body.text).toContain('America/New_York');
    });

    test('`/ball schedule every weekday at 9:30am` uses MON-FRI shorthand', async () => {
      getSchedule.mockResolvedValue(currentSchedule);
      updateSchedule.mockResolvedValue({});

      await handler(
        event({
          command: '/ball',
          text: 'schedule every weekday at 9:30am',
          user_id: 'U123',
          user_name: 'alice',
          channel_id: 'C_CURRENT',
        }),
      );

      expect(updateSchedule.mock.calls[0][0].scheduleExpression).toBe(
        'cron(30 9 ? * MON-FRI *)',
      );
    });

    test('`/ball schedule every day at noon` maps to every-day cron', async () => {
      getSchedule.mockResolvedValue(currentSchedule);
      updateSchedule.mockResolvedValue({});

      await handler(
        event({
          command: '/ball',
          text: 'schedule every day at noon',
          user_id: 'U123',
          user_name: 'alice',
          channel_id: 'C_CURRENT',
        }),
      );

      expect(updateSchedule.mock.calls[0][0].scheduleExpression).toBe(
        'cron(0 12 ? * * *)',
      );
    });

    test('`/ball schedule bogus` returns an ephemeral parse error without calling updateSchedule', async () => {
      getSchedule.mockResolvedValue(currentSchedule);

      const res = await handler(
        event({
          command: '/ball',
          text: 'schedule bogus',
          user_id: 'U123',
          user_name: 'alice',
          channel_id: 'C_CURRENT',
        }),
      );

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.response_type).toBe('ephemeral');
      expect(body.text).toMatch(/couldn't parse/i);
      expect(body.text).toMatch(/examples/i);
      expect(updateSchedule).not.toHaveBeenCalled();
      expect(notifyFailure).not.toHaveBeenCalled();
    });

    test('`/ball schedule Tuesday at 8am` (no "every") is rejected with a suggested fix', async () => {
      getSchedule.mockResolvedValue(currentSchedule);

      const res = await handler(
        event({
          command: '/ball',
          text: 'schedule Tuesday at 8am',
          user_id: 'U123',
          user_name: 'alice',
          channel_id: 'C_CURRENT',
        }),
      );

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.response_type).toBe('ephemeral');
      expect(body.text).toMatch(/one-shot/i);
      expect(body.text).toContain('every Tuesday at 8am');
      expect(updateSchedule).not.toHaveBeenCalled();
      expect(notifyFailure).not.toHaveBeenCalled();
    });

  });

  describe('parseMessageRef', () => {
    test('parses a Slack archive link into channel + ts', () => {
      expect(
        parseMessageRef(
          'https://example.slack.com/archives/C0123456789/p1782227415336489',
        ),
      ).toEqual({ channel: 'C0123456789', ts: '1782227415.336489' });
    });

    test('parses a thread link with query params', () => {
      expect(
        parseMessageRef(
          'https://x.slack.com/archives/C0123456789/p1782227415336489?thread_ts=1.2&cid=C0123456789',
        ),
      ).toEqual({ channel: 'C0123456789', ts: '1782227415.336489' });
    });

    test('parses a bare dotted timestamp (channel from context)', () => {
      expect(parseMessageRef('1782227415.336489')).toEqual({
        channel: null,
        ts: '1782227415.336489',
      });
    });

    test('parses a pasted p-prefixed id', () => {
      expect(parseMessageRef('p1782227415336489')).toEqual({
        channel: null,
        ts: '1782227415.336489',
      });
    });

    test('returns null for empty input', () => {
      expect(parseMessageRef('')).toBeNull();
      expect(parseMessageRef('   ')).toBeNull();
    });

    test('returns undefined for unparseable input', () => {
      expect(parseMessageRef('garbage')).toBeUndefined();
    });
  });

  describe('delete command', () => {
    test('shows usage when no target is given', async () => {
      const res = await handler(
        event({
          command: '/ball',
          text: 'delete',
          user_id: 'U123',
          user_name: 'alice',
          channel_id: 'C_CURRENT',
        }),
      );
      const body = JSON.parse(res.body);
      expect(body.response_type).toBe('ephemeral');
      expect(body.text).toMatch(/Usage/);
      expect(deleteMessage).not.toHaveBeenCalled();
    });

    test('deletes a message by archive link using the link channel', async () => {
      deleteMessage.mockResolvedValue({ ok: true });
      const res = await handler(
        event({
          command: '/ball',
          text: 'delete https://example.slack.com/archives/C03OTHER01/p1782227415336489',
          user_id: 'U123',
          user_name: 'alice',
          channel_id: 'C_CURRENT',
        }),
      );
      expect(deleteMessage).toHaveBeenCalledWith({
        token: 'xoxb-test',
        channel: 'C03OTHER01',
        ts: '1782227415.336489',
      });
      expect(JSON.parse(res.body).text).toMatch(/Deleted/);
    });

    test('deletes a bare timestamp using the current channel', async () => {
      deleteMessage.mockResolvedValue({ ok: true });
      await handler(
        event({
          command: '/ball',
          text: 'delete 1782227415.336489',
          user_id: 'U123',
          user_name: 'alice',
          channel_id: 'C_CURRENT',
        }),
      );
      expect(deleteMessage).toHaveBeenCalledWith({
        token: 'xoxb-test',
        channel: 'C_CURRENT',
        ts: '1782227415.336489',
      });
    });

    test('reports a friendly message when Slack says message_not_found', async () => {
      const err = new Error('Slack chat.delete error: message_not_found');
      err.slackError = 'message_not_found';
      deleteMessage.mockRejectedValue(err);
      const res = await handler(
        event({
          command: '/ball',
          text: 'delete 1782227415.336489',
          user_id: 'U123',
          user_name: 'alice',
          channel_id: 'C_CURRENT',
        }),
      );
      expect(JSON.parse(res.body).text).toMatch(/Could not find that message/);
      expect(notifyFailure).not.toHaveBeenCalled();
    });

    test('rejects unparseable target without calling Slack', async () => {
      const res = await handler(
        event({
          command: '/ball',
          text: 'delete garbage',
          user_id: 'U123',
          user_name: 'alice',
          channel_id: 'C_CURRENT',
        }),
      );
      expect(JSON.parse(res.body).text).toMatch(/Could not parse/);
      expect(deleteMessage).not.toHaveBeenCalled();
    });
  });
});
