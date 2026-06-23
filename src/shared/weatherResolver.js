import { fetchWeather } from '../postMessage/weather.js';
import { parseWeatherLine } from './formatMessage.js';
import { getChannelHistory } from './slack.js';

const WEATHER_MAX_ATTEMPTS = 3;
const WEATHER_RETRY_DELAY_MS = 500;

export async function fetchWeatherWithRetry({ target = 'noon' } = {}) {
  for (let attempt = 1; attempt <= WEATHER_MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await fetchWeather({ target });
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

// When the live NWS fetch is unrecoverable, fall back to the weather line from
// the most recent bot post in any channel. The line is preserved verbatim and
// tagged "(cached)" so readers know it's stale.
export async function loadCachedWeatherLine({ token, channels, botUserId }) {
  for (const channel of channels) {
    try {
      const history = await getChannelHistory({ token, channel, limit: 20 });
      const target = (history?.messages ?? []).find((m) => m.user === botUserId);
      const line = parseWeatherLine(target?.text ?? '');
      if (line) return `${line} (cached)`;
    } catch (err) {
      console.error('cached-weather lookup failed', channel, err);
    }
  }
  return null;
}

// Resolve the weather to render: live NWS (with retry) first, then the cached
// line from a prior post if the live fetch is unrecoverable. Returns a weather
// object, a "(cached)" string, or null when nothing is available.
export async function resolveWeather({ token, channels = [], botUserId, target = 'noon' }) {
  let weather = await fetchWeatherWithRetry({ target });
  if (!weather && botUserId) {
    weather = await loadCachedWeatherLine({ token, channels, botUserId });
    if (weather) console.warn('weather fetch failed; using cached line from prior post');
  }
  return weather;
}
