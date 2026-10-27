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

// reactions.get can trail the event: a read taken right after reaction_added
// may not list the new reaction yet, and the post would be rewritten without
// it. Re-read after each delay until the event shows. Total stays well under
// Slack's 3s event deadline.
const RESYNC_DELAYS_MS = [250, 500, 750];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function reflectsEvent(reactions, inner) {
  if (!inner.user || !inner.reaction) return true;
  const entry = reactions.find((r) => r.name === inner.reaction);
  const present = entry?.users?.includes(inner.user) ?? false;
  return inner.type === 'reaction_added' ? present : !present;
}

// If the event never shows, the last read wins: a later opposite event may
// have already undone it.
async function readReactions({ token, channel, ts, inner }) {
  let reactions = [];
  for (const delay of [0, ...RESYNC_DELAYS_MS]) {
    if (delay) await sleep(delay);
    const result = await getReactions({ token, channel, ts });
    reactions = result.message?.reactions ?? [];
    if (reflectsEvent(reactions, inner)) break;
  }
  return reactions;
}

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
    if (!original || original.ts !== ts || original.user !== botUserId) {
      return response(200);
    }

    const reactions = await readReactions({ token, channel, ts, inner });
    const roster = categorize(reactions, botUserId);

    const originalText = original.text ?? '';
    const weatherLine = parseWeatherLine(originalText);
    const headerText = parseHeader(originalText);
    const newText = formatMessage(roster, weatherLine, { headerText });

    try {
      await updateMessage({ token, channel, ts, text: newText });
    } catch (err) {
      if (
        err.slackError === 'cant_update_message' ||
        err.slackError === 'message_not_found'
      ) {
        return response(200);
      }
      throw err;
    }
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
