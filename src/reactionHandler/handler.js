import { verifySignature } from './verifySignature.js';
import { categorize } from './categorize.js';
import {
  formatMessage,
  parseWeatherLine,
  parseHeader,
} from '../shared/formatMessage.js';
import {
  getHistory,
  getReactions,
  updateMessage,
  notifyFailure,
} from '../shared/slack.js';

const REACTION_EVENTS = new Set(['reaction_added', 'reaction_removed']);

function response(statusCode, body = '') {
  return { statusCode, body };
}

export async function handler(event) {
  const token = process.env.SLACK_BOT_TOKEN;
  const secret = process.env.SLACK_SIGNING_SECRET;
  const botUserId = process.env.SLACK_BOT_USER_ID;

  const body = event.body ?? '';
  const signature = event.headers?.['x-slack-signature'];
  const timestamp = event.headers?.['x-slack-request-timestamp'];

  if (!verifySignature({ body, timestamp, signature, secret })) {
    return response(401, 'invalid signature');
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return response(400, 'invalid json');
  }

  if (payload.type === 'url_verification') {
    return response(200, payload.challenge ?? '');
  }

  const inner = payload.event;
  if (!inner || !REACTION_EVENTS.has(inner.type)) {
    return response(200);
  }

  const { channel, ts } = inner.item ?? {};
  if (!channel || !ts) return response(200);

  try {
    const history = await getHistory({ token, channel, ts });
    const original = history.messages?.[0];
    if (!original || original.user !== botUserId) {
      return response(200);
    }

    const reactionsResult = await getReactions({ token, channel, ts });
    const reactions = reactionsResult.message?.reactions ?? [];
    const roster = categorize(reactions, botUserId);

    const originalText = original.text ?? '';
    const weatherLine = parseWeatherLine(originalText);
    const headerText = parseHeader(originalText);
    const newText = formatMessage(roster, weatherLine, { headerText });

    await updateMessage({ token, channel, ts, text: newText });
    return response(200);
  } catch (err) {
    await notifyFailure({
      token,
      error: err,
      context: { lambda: 'reactionHandler', channel, ts },
    });
    return response(500, 'internal error');
  }
}
