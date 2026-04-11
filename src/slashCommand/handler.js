import { verifySignature } from '../reactionHandler/verifySignature.js';
import { categorize } from '../reactionHandler/categorize.js';
import { fetchWeather } from '../postMessage/weather.js';
import { formatMessage } from '../shared/formatMessage.js';
import {
  postMessage,
  getUserInfo,
  notifyFailure,
  getChannelHistory,
  getReactions,
  updateMessage,
} from '../shared/slack.js';
import {
  getSchedule,
  updateSchedule,
  normalizeScheduleExpression,
} from '../shared/scheduler.js';

const EMPTY_ROSTER = { in: [], out: [], unsure: [] };
const WEATHER_TIMEOUT_MS = 2000;

function response(statusCode, body = '', headers) {
  return { statusCode, body, headers };
}

function ephemeral(text) {
  return response(
    200,
    JSON.stringify({ response_type: 'ephemeral', text }),
    { 'Content-Type': 'application/json' },
  );
}

function decodeBody(event) {
  const raw = event.body ?? '';
  if (event.isBase64Encoded) {
    return Buffer.from(raw, 'base64').toString('utf-8');
  }
  return raw;
}

function formatScheduleView({ scheduleName, current }) {
  const expr = current?.ScheduleExpression ?? 'unknown';
  const tz = current?.ScheduleExpressionTimezone ?? 'UTC';
  const state = current?.State ?? 'ENABLED';
  return [
    `📅 Current bball schedule (*${scheduleName}*)`,
    `• Expression: \`${expr}\``,
    `• Timezone: ${tz}`,
    `• State: ${state}`,
    '',
    'Update with `/ball schedule <cron expression>` — e.g.',
    '`/ball schedule 0 7 ? * MON,WED,FRI *`',
    '',
    '_Note: changes via `/ball schedule` may be reset on the next `sam deploy`._',
  ].join('\n');
}

async function handleSchedule({
  token,
  userId,
  scheduleName,
  scheduleGroup,
  scheduleText,
}) {
  if (!scheduleName) {
    return ephemeral(
      'Schedule name is not configured (missing `SCHEDULE_NAME` env var).',
    );
  }

  let current;
  try {
    current = await getSchedule({ name: scheduleName, groupName: scheduleGroup });
  } catch (err) {
    await notifyFailure({
      token,
      error: err,
      context: {
        lambda: 'slashCommand',
        phase: 'scheduler.getSchedule',
        scheduleName,
        user: userId,
      },
    });
    return ephemeral(`Couldn't fetch schedule: ${err.message}`);
  }

  if (!scheduleText) {
    return ephemeral(formatScheduleView({ scheduleName, current }));
  }

  const newExpression = normalizeScheduleExpression(scheduleText);

  try {
    await updateSchedule({
      name: scheduleName,
      groupName: scheduleGroup,
      scheduleExpression: newExpression,
      scheduleExpressionTimezone: current.ScheduleExpressionTimezone,
      flexibleTimeWindow: current.FlexibleTimeWindow,
      target: current.Target,
      state: current.State,
    });
  } catch (err) {
    await notifyFailure({
      token,
      error: err,
      context: {
        lambda: 'slashCommand',
        phase: 'scheduler.updateSchedule',
        scheduleName,
        scheduleExpression: newExpression,
        user: userId,
      },
    });
    return ephemeral(`Schedule update failed: ${err.message}`);
  }

  const tz = current.ScheduleExpressionTimezone ?? 'UTC';
  return ephemeral(
    [
      `✅ Schedule updated.`,
      `• Expression: \`${newExpression}\``,
      `• Timezone: ${tz}`,
      '',
      '_Note: this change may be reset on the next `sam deploy`._',
    ].join('\n'),
  );
}

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
        user: userId,
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
        user: userId,
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
        user: userId,
      },
    });
    return response(500, 'internal error');
  }
}

export async function handler(event) {
  const token = process.env.SLACK_BOT_TOKEN;
  const secret = process.env.SLACK_SIGNING_SECRET;
  const owmKey = process.env.OPENWEATHERMAP_API_KEY;

  const rawBody = decodeBody(event);
  const signature = event.headers?.['x-slack-signature'];
  const timestamp = event.headers?.['x-slack-request-timestamp'];

  if (!verifySignature({ body: rawBody, timestamp, signature, secret })) {
    return response(401, 'invalid signature');
  }

  const params = new URLSearchParams(rawBody);
  const text = (params.get('text') ?? '').trim();
  const userId = params.get('user_id') ?? '';
  const userName = params.get('user_name') ?? '';
  const channelId = params.get('channel_id') ?? '';

  if (!text) {
    return ephemeral('Usage: `/ball <message>` — e.g. `/ball tonight at 7pm, outdoor courts`');
  }

  const scheduleMatch = /^schedule(\s+(.*))?$/i.exec(text);
  if (scheduleMatch) {
    const scheduleText = (scheduleMatch[2] ?? '').trim();
    return handleSchedule({
      token,
      userId,
      scheduleName: process.env.SCHEDULE_NAME ?? '',
      scheduleGroup: process.env.SCHEDULE_GROUP ?? 'default',
      scheduleText,
    });
  }

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
      channelId,
      userId,
      userName,
      editText,
      owmKey,
    });
  }

  if (!channelId) {
    return ephemeral('Could not determine the current channel.');
  }

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

  const headerText = `${text} (${displayName})`;

  let weather = null;
  try {
    weather = await fetchWeather(owmKey, {
      timeoutMs: WEATHER_TIMEOUT_MS,
      target: 'now',
    });
  } catch (err) {
    console.error('weather fetch failed', err);
  }

  const body = formatMessage(EMPTY_ROSTER, weather, { headerText });

  try {
    await postMessage({ token, channel: channelId, text: body });
    return response(200);
  } catch (err) {
    await notifyFailure({
      token,
      error: err,
      context: {
        lambda: 'slashCommand',
        phase: 'chat.postMessage',
        user: userId,
        channel: channelId,
      },
    });
    return response(500, 'internal error');
  }
}
