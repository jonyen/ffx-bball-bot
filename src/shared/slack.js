export const FAILURE_DM_USER = 'U05SWHWFTEH';

const BASE = 'https://slack.com/api';

async function callPost(method, token, body) {
  const response = await fetch(`${BASE}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Slack ${method} HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Slack ${method} error: ${data.error}`);
  }
  return data;
}

async function callGet(method, token, params) {
  const qs = new URLSearchParams(params).toString();
  const response = await fetch(`${BASE}/${method}?${qs}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Slack ${method} HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Slack ${method} error: ${data.error}`);
  }
  return data;
}

export function postMessage({ token, channel, text }) {
  return callPost('chat.postMessage', token, { channel, text });
}

export function updateMessage({ token, channel, ts, text }) {
  return callPost('chat.update', token, { channel, ts, text });
}

export function getHistory({ token, channel, ts }) {
  return callGet('conversations.history', token, {
    channel,
    latest: ts,
    inclusive: 'true',
    limit: '1',
  });
}

export function getChannelHistory({ token, channel, limit = 20 }) {
  return callGet('conversations.history', token, {
    channel,
    limit: String(limit),
  });
}

export function getReactions({ token, channel, ts }) {
  return callGet('reactions.get', token, { channel, timestamp: ts });
}

export function getUserInfo({ token, userId }) {
  return callGet('users.info', token, { user: userId });
}

function formatError(error) {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  return String(error);
}

export function parseChannels(envValue) {
  return (envValue ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function notifyFailure({ token, error, context }) {
  try {
    const ctxLines = Object.entries(context ?? {})
      .map(([k, v]) => `• ${k}: ${v}`)
      .join('\n');
    const text =
      `🏀 bball bot failure\n` +
      (ctxLines ? `${ctxLines}\n\n` : '\n') +
      '```\n' +
      formatError(error) +
      '\n```';

    await postMessage({ token, channel: FAILURE_DM_USER, text });
  } catch (dmError) {
    console.error('notifyFailure: failed to send DM', dmError);
  }
}
