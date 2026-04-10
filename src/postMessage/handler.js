import { fetchWeather } from './weather.js';
import { formatMessage } from '../shared/formatMessage.js';
import { postMessage, notifyFailure } from '../shared/slack.js';

const EMPTY_ROSTER = { in: [], out: [], unsure: [] };

export async function handler(_event) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL;
  const owmKey = process.env.OPENWEATHERMAP_API_KEY;

  let weather = null;
  try {
    weather = await fetchWeather(owmKey);
  } catch (err) {
    console.error('weather fetch failed', err);
  }

  const text = formatMessage(EMPTY_ROSTER, weather);

  try {
    return await postMessage({ token, channel, text });
  } catch (err) {
    await notifyFailure({
      token,
      error: err,
      context: {
        lambda: 'postMessage',
        phase: 'chat.postMessage',
        channel,
      },
    });
    throw err;
  }
}
