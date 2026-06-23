import { formatMessage } from '../shared/formatMessage.js';
import {
  postMessage,
  notifyFailure,
  parseChannels,
} from '../shared/slack.js';
import { resolveWeather } from '../shared/weatherResolver.js';

const EMPTY_ROSTER = { in: [], out: [], maybe: [] };

export async function handler(_event) {
  const token = process.env.SLACK_BOT_TOKEN;
  const botUserId = process.env.SLACK_BOT_USER_ID;
  const channels = parseChannels(process.env.SLACK_CHANNELS);

  const weather = await resolveWeather({ token, channels, botUserId, target: 'noon' });

  const text = formatMessage(EMPTY_ROSTER, weather);

  // Fanout pattern mirrors slashCommand/handler.js. If you fix a bug here, check there too.
  const results = await Promise.allSettled(
    channels.map((channel) => postMessage({ token, channel, text })),
  );

  const failures = [];
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    if (result.status === 'rejected') {
      const channel = channels[i];
      failures.push({ channel, error: result.reason });
      await notifyFailure({
        token,
        error: result.reason,
        context: {
          lambda: 'postMessage',
          phase: 'chat.postMessage',
          channel,
        },
      });
    }
  }

  if (failures.length === channels.length && channels.length > 0) {
    throw failures[0].error;
  }

  return results
    .filter((r) => r.status === 'fulfilled')
    .map((r) => r.value);
}
