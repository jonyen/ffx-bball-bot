import { fetchWeather } from './weather.js';
import { formatMessage } from '../shared/formatMessage.js';
import { postMessage, notifyFailure, parseChannels } from '../shared/slack.js';

const EMPTY_ROSTER = { in: [], out: [], maybe: [] };
const WEATHER_MAX_ATTEMPTS = 3;
const WEATHER_RETRY_DELAY_MS = 500;

async function fetchWeatherWithRetry() {
  for (let attempt = 1; attempt <= WEATHER_MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await fetchWeather();
      if (result) return result;
    } catch (err) {
      console.error(`weather fetch attempt ${attempt} failed`, err);
    }
    if (attempt < WEATHER_MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, WEATHER_RETRY_DELAY_MS));
    }
  }
  return null;
}

export async function handler(_event) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channels = parseChannels(process.env.SLACK_CHANNELS);

  const weather = await fetchWeatherWithRetry();

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
