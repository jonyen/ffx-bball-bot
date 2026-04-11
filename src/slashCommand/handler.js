import { verifySignature } from '../reactionHandler/verifySignature.js';
import { fetchWeather } from '../postMessage/weather.js';
import { formatMessage } from '../shared/formatMessage.js';
import { postMessage, getUserInfo, notifyFailure } from '../shared/slack.js';

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

export async function handler(event) {
  const token = process.env.SLACK_BOT_TOKEN;
  const secret = process.env.SLACK_SIGNING_SECRET;
  const channel = process.env.SLACK_CHANNEL;
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

  if (!text) {
    return ephemeral('Usage: `/ball <message>` — e.g. `/ball tonight at 7pm, outdoor courts`');
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
    await postMessage({ token, channel, text: body });
    return response(200);
  } catch (err) {
    await notifyFailure({
      token,
      error: err,
      context: {
        lambda: 'slashCommand',
        user: userId,
        channel,
      },
    });
    return response(500, 'internal error');
  }
}
