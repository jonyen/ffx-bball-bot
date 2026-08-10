import { formatMessage } from '../shared/formatMessage.js';
import {
  postMessage,
  notifyFailure,
  parseChannels,
} from '../shared/slack.js';
import { resolveWeather } from '../shared/weatherResolver.js';
import { log, metric, withCorrelationId } from '../shared/logger.js';

const EMPTY_ROSTER = { in: [], out: [], maybe: [] };
const DIMENSIONS = { Lambda: 'postMessage' };

export async function handler(_event, context) {
  return withCorrelationId(context?.awsRequestId, () => run());
}

async function run() {
  const token = process.env.SLACK_BOT_TOKEN;
  const botUserId = process.env.SLACK_BOT_USER_ID;
  const channels = parseChannels(process.env.SLACK_CHANNELS);

  log.info('roll call starting', { channelCount: channels.length });

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
      log.error('roll call post failed', { channel, error: result.reason });
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

  const posted = results.length - failures.length;

  // The SLI. RollCallPosted is what "the bot worked" means — Lambda finishing
  // without throwing does not imply anyone saw a roll call. The heartbeat alarm
  // watches this metric going missing, which is the failure Lambda errors miss.
  metric('RollCallPosted', posted, { dimensions: DIMENSIONS });
  if (failures.length > 0) {
    metric('RollCallFailed', failures.length, { dimensions: DIMENSIONS });
  }

  log.info('roll call finished', { posted, failed: failures.length });

  if (failures.length === channels.length && channels.length > 0) {
    throw failures[0].error;
  }

  return results
    .filter((r) => r.status === 'fulfilled')
    .map((r) => r.value);
}
