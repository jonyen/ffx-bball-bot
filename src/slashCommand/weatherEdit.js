import { categorize } from '../reactionHandler/categorize.js';
import { resolveWeather } from '../shared/weatherResolver.js';
import { formatMessage, parseHeader } from '../shared/formatMessage.js';
import {
  getReactions,
  updateMessage,
  notifyFailure,
  parseChannels,
} from '../shared/slack.js';

// Worker invoked asynchronously by the /ball slash command after it posts the
// (weather-less) roll-call message. Slack slash commands must get an HTTP 200
// within 3s, so the synchronous handler can't wait on the slow NWS fetch. This
// function does that fetch out-of-band and edits the weather line into the
// already-posted message.
//
// event: { channel, ts }
export async function handler(event) {
  const token = process.env.SLACK_BOT_TOKEN;
  const botUserId = process.env.SLACK_BOT_USER_ID;
  const channels = parseChannels(process.env.SLACK_CHANNELS);

  const channel = event?.channel;
  const ts = event?.ts;
  if (!channel || !ts) {
    console.error('weatherEdit: missing channel/ts in event', event);
    return;
  }

  // Re-read the live message so we preserve whatever roster/header it now has
  // (a reaction may have landed between the post and this edit).
  let message;
  try {
    const result = await getReactions({ token, channel, ts });
    message = result.message ?? {};
  } catch (err) {
    await notifyFailure({
      token,
      error: err,
      context: { lambda: 'weatherEdit', phase: 'reactions.get', channel, ts },
    });
    return;
  }

  const roster = categorize(message.reactions ?? [], botUserId);
  const headerText = parseHeader(message.text ?? '');

  const weather = await resolveWeather({ token, channels, botUserId, target: 'now' });
  if (!weather) {
    // Nothing to add — leave the posted message untouched.
    return;
  }

  const text = formatMessage(roster, weather, { headerText });

  try {
    await updateMessage({ token, channel, ts, text });
  } catch (err) {
    await notifyFailure({
      token,
      error: err,
      context: { lambda: 'weatherEdit', phase: 'chat.update', channel, ts },
    });
  }
}
