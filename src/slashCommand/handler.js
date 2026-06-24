import { verifySignature } from '../reactionHandler/verifySignature.js';
import { categorize } from '../reactionHandler/categorize.js';
import { formatMessage } from '../shared/formatMessage.js';
import {
  postMessage,
  getUserInfo,
  notifyFailure,
  getChannelHistory,
  getReactions,
  updateMessage,
  deleteMessage,
} from '../shared/slack.js';
import { getSchedule, updateSchedule } from '../shared/scheduler.js';
import { parseScheduleInput } from '../shared/scheduleParser.js';
import { invokeAsync } from '../shared/invokeLambda.js';

const EMPTY_ROSTER = { in: [], out: [], maybe: [] };

// Post the message without weather first, then fill the weather line in via an
// async worker. Slack slash commands must get an HTTP 200 within 3s; the NWS
// fetch is too slow to do inline (it caused `operation_timeout` errors).
async function scheduleWeatherEdit({ channel, ts }) {
  const functionName = process.env.WEATHER_EDIT_FUNCTION;
  if (!functionName) return;
  try {
    await invokeAsync({ functionName, payload: { channel, ts } });
  } catch (err) {
    // Non-fatal: the message is already posted, it just won't gain a weather
    // line. Don't await notifyFailure here — it would add latency to the 200.
    console.error('weatherEdit invoke failed', err);
  }
}

const USAGE_HELP = [
  '*Usage*',
  '• `/ball <message>` — post a new bball message',
  '• `/ball edit <message>` — edit the most recent bball message',
  '• `/ball delete <message link or timestamp>` — delete a specific bball message',
  '• `/ball schedule` — show the current schedule',
  '• `/ball schedule <desired schedule>` — update the schedule using natural language (e.g. `every Tue, Thu at 8am`)',
  '• `/ball schedule pause` — pause the schedule',
  '• `/ball schedule resume` — resume the schedule',
  '• `/ball info` — show the deployed commit SHA and GitHub run number',
].join('\n');

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
    'Update with natural language (like `/remind`) — e.g.',
    '• `/ball schedule every Tue, Thu at 8am`',
    '• `/ball schedule every weekday at 9:30am`',
    '• `/ball schedule every day at noon`',
    '',
    'Pause or resume:',
    '• `/ball schedule pause`',
    '• `/ball schedule resume`',
  ].join('\n');
}

const PARSE_HELP = [
  'Examples:',
  '• `/ball schedule every Tue, Thu at 8am`',
  '• `/ball schedule every weekday at 9:30am`',
  '• `/ball schedule every day at noon`',
].join('\n');

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

  const toggle = /^(pause|resume)$/i.exec(scheduleText);
  if (toggle) {
    const newState = toggle[1].toLowerCase() === 'pause' ? 'DISABLED' : 'ENABLED';
    try {
      await updateSchedule({
        name: scheduleName,
        groupName: scheduleGroup,
        scheduleExpression: current.ScheduleExpression,
        scheduleExpressionTimezone: current.ScheduleExpressionTimezone,
        flexibleTimeWindow: current.FlexibleTimeWindow,
        target: current.Target,
        state: newState,
      });
    } catch (err) {
      await notifyFailure({
        token,
        error: err,
        context: {
          lambda: 'slashCommand',
          phase: 'scheduler.updateSchedule',
          scheduleName,
          state: newState,
          user: userId,
        },
      });
      return ephemeral(`Schedule update failed: ${err.message}`);
    }
    const verb = newState === 'DISABLED' ? '⏸️ Paused' : '▶️ Resumed';
    return ephemeral(`${verb} bball schedule (*${scheduleName}*).`);
  }

  let parsed;
  try {
    parsed = parseScheduleInput(scheduleText);
  } catch (err) {
    return ephemeral(`Couldn't parse schedule: ${err.message}\n\n${PARSE_HELP}`);
  }

  const newExpression = parsed.expression;

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
      `• Interpreted as: ${parsed.summary} (${tz})`,
    ].join('\n'),
  );
}

// Parse a `/ball delete` argument into an explicit message reference.
// Accepts a Slack archive link (…/archives/<channel>/p<digits>) or a bare
// message timestamp (1782227415.336489). Returns null when no target is given
// (caller shows usage), undefined when the argument is present but unparseable.
export function parseMessageRef(arg) {
  const trimmed = (arg ?? '').trim();
  if (!trimmed) return null;

  const link = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})\b/i.exec(trimmed);
  if (link) {
    return { channel: link[1], ts: `${link[2]}.${link[3]}` };
  }

  const tsMatch = /^(\d{10})\.(\d{6})$/.exec(trimmed);
  if (tsMatch) {
    return { channel: null, ts: `${tsMatch[1]}.${tsMatch[2]}` };
  }

  // p1782227415336489 pasted without the surrounding link.
  const bare = /^p?(\d{10})(\d{6})$/.exec(trimmed);
  if (bare) {
    return { channel: null, ts: `${bare[1]}.${bare[2]}` };
  }

  return undefined;
}

async function handleDeleteRef({ token, channelId, ts, userId }) {
  try {
    await deleteMessage({ token, channel: channelId, ts });
    return ephemeral('🗑️ Deleted that bball message.');
  } catch (err) {
    if (err.slackError === 'message_not_found') {
      return ephemeral(
        'Could not find that message in this channel. Make sure the link points here, or run `/ball delete` from the channel the message is in.',
      );
    }
    if (err.slackError === 'cant_delete_message') {
      return ephemeral('I can only delete messages I posted.');
    }
    await notifyFailure({
      token,
      error: err,
      context: {
        lambda: 'slashCommand',
        phase: 'chat.delete',
        channel: channelId,
        ts,
        user: userId,
      },
    });
    return ephemeral(`Delete failed: ${err.message}`);
  }
}

const DELETE_USAGE =
  'Usage: `/ball delete <message link or timestamp>` — e.g. `/ball delete https://…/archives/C…/p1782227415336489`. Copy the link via a message’s ⋯ menu → *Copy link*.';

async function handleDelete({ token, channelId, userId, arg }) {
  const ref = parseMessageRef(arg);
  if (ref === null) {
    return ephemeral(DELETE_USAGE);
  }
  if (ref === undefined) {
    return ephemeral(`Could not parse that.\n\n${DELETE_USAGE}`);
  }

  const channel = ref.channel ?? channelId;
  if (!channel) {
    return ephemeral('Could not determine the channel to delete from.');
  }
  return handleDeleteRef({ token, channelId: channel, ts: ref.ts, userId });
}

async function handleEdit({
  token,
  botUserId,
  channelId,
  userId,
  userName,
  editText,
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

  const headerText = `${editText} (${displayName})`;
  const newBody = formatMessage(roster, null, { headerText });

  try {
    await updateMessage({ token, channel: channelId, ts, text: newBody });
    await scheduleWeatherEdit({ channel: channelId, ts });
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
    return ephemeral(USAGE_HELP);
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

  const deleteMatch = /^delete(\s+(.*))?$/i.exec(text);
  if (deleteMatch) {
    return handleDelete({
      token,
      channelId,
      userId,
      arg: (deleteMatch[2] ?? '').trim(),
    });
  }

  if (/^info\s*$/i.test(text)) {
    const sha = process.env.GIT_SHA || 'unknown';
    const githubRunNumber = process.env.GITHUB_RUN_NUMBER || 'unknown';
    return ephemeral(
      `*bball bot*\n• Commit: \`${sha}\`\n• GitHub run: \`#${githubRunNumber}\``,
    );
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
  const body = formatMessage(EMPTY_ROSTER, null, { headerText });

  try {
    const posted = await postMessage({ token, channel: channelId, text: body });
    await scheduleWeatherEdit({ channel: posted.channel ?? channelId, ts: posted.ts });
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
