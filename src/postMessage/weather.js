const FAIRFAX_LAT = 38.8462;
const FAIRFAX_LON = -77.3064;
const DEFAULT_TIMEOUT_MS = 3000;
const POINTS_URL = `https://api.weather.gov/points/${FAIRFAX_LAT},${FAIRFAX_LON}`;
const USER_AGENT = 'ffx-bball-bot (https://github.com/jonyen/ffx-bball-bot)';

// Order matters: more specific rules first so "Mostly Sunny" doesn't fall
// through to the bare "sunny" rule, and thunder beats plain rain.
const ICON_RULES = [
  [/thunder|t-storm/i, '⛈️'],
  [/snow|sleet|ice|blizzard|flurries/i, '❄️'],
  [/rain|shower|drizzle/i, '🌧️'],
  [/fog|mist|haze|smoke/i, '🌫️'],
  [/partly|mostly sunny|mostly clear/i, '⛅'],
  [/sunny|clear/i, '☀️'],
  [/cloud|overcast/i, '☁️'],
];

export function pickIcon(shortForecast = '') {
  for (const [re, icon] of ICON_RULES) {
    if (re.test(shortForecast)) return icon;
  }
  return '🌡️';
}

// Unix milliseconds for 12:00 local time in America/New_York on the ET calendar
// date of `now`. DST-safe via Intl.DateTimeFormat.
export function noonEtMsFor(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === 'year').value);
  const month = Number(parts.find((p) => p.type === 'month').value);
  const day = Number(parts.find((p) => p.type === 'day').value);

  const probe = Date.UTC(year, month - 1, day, 12, 0, 0);
  const etHour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hour12: false,
    }).format(new Date(probe)),
  );
  return probe + (12 - etHour) * 3600 * 1000;
}

function pickClosest(periods, targetMs) {
  if (!Array.isArray(periods) || periods.length === 0) return null;
  let best = null;
  let bestDiff = Infinity;
  for (const p of periods) {
    const t = new Date(p.startTime).getTime();
    if (Number.isNaN(t)) continue;
    const diff = Math.abs(t - targetMs);
    if (diff < bestDiff) {
      best = p;
      bestDiff = diff;
    }
  }
  return best;
}

async function nwsFetch(url, signal) {
  const response = await fetch(url, {
    signal,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/geo+json',
    },
  });
  if (!response.ok) return null;
  return response.json();
}

export async function fetchWeather({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = new Date(),
  target = 'noon',
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const targetMs = target === 'now' ? now.getTime() : noonEtMsFor(now);

  try {
    const points = await nwsFetch(POINTS_URL, controller.signal);
    const forecastHourlyUrl = points?.properties?.forecastHourly;
    if (!forecastHourlyUrl) return null;

    const forecast = await nwsFetch(forecastHourlyUrl, controller.signal);
    const entry = pickClosest(forecast?.properties?.periods, targetMs);
    if (!entry) return null;

    const shortForecast = entry.shortForecast ?? '';
    return {
      icon: pickIcon(shortForecast),
      tempF: Math.round(entry.temperature ?? 0),
      description: shortForecast,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
