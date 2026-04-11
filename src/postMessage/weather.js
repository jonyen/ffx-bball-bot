const FAIRFAX_LAT = 38.8462;
const FAIRFAX_LON = -77.3064;
const DEFAULT_TIMEOUT_MS = 3000;

const ICONS = {
  Clear: '☀️',
  Clouds: '☁️',
  Rain: '🌧️',
  Drizzle: '🌧️',
  Snow: '❄️',
  Thunderstorm: '⛈️',
};

export function pickIcon(main) {
  return ICONS[main] || '🌡️';
}

function capitalize(s) {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1);
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

function pickClosest(list, targetMs) {
  if (!Array.isArray(list) || list.length === 0) return null;
  let best = list[0];
  let bestDiff = Math.abs(list[0].dt * 1000 - targetMs);
  for (let i = 1; i < list.length; i++) {
    const diff = Math.abs(list[i].dt * 1000 - targetMs);
    if (diff < bestDiff) {
      best = list[i];
      bestDiff = diff;
    }
  }
  return best;
}

export async function fetchWeather(
  apiKey,
  { timeoutMs = DEFAULT_TIMEOUT_MS, now = new Date(), target = 'noon' } = {},
) {
  const url =
    `https://api.openweathermap.org/data/2.5/forecast` +
    `?lat=${FAIRFAX_LAT}&lon=${FAIRFAX_LON}&units=imperial&appid=${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const targetMs = target === 'now' ? now.getTime() : noonEtMsFor(now);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const data = await response.json();
    const entry = pickClosest(data.list, targetMs);
    if (!entry) return null;
    const main = entry.weather?.[0]?.main ?? '';
    const description = capitalize(entry.weather?.[0]?.description ?? '');
    return {
      icon: pickIcon(main),
      tempF: Math.round(entry.main?.temp ?? 0),
      description,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
