const DEFAULT_HEADER_TEXT = '🏀 today?';
const DIVIDER = '──────────────';

function weatherLine(weather) {
  if (weather == null) return null;
  if (typeof weather === 'string') return weather;
  return `${weather.icon} Fairfax, VA — ${weather.tempF}°F, ${weather.description}`;
}

function mentions(users) {
  return users.map((u) => `<@${u}>`).join(', ');
}

export function formatMessage(roster, weather, { headerText } = {}) {
  const header = headerText || DEFAULT_HEADER_TEXT;
  const sections = [header];

  const rosterLines = [];
  if (roster.in.length) rosterLines.push(`In (${roster.in.length}): ${mentions(roster.in)}`);
  if (roster.maybe.length) rosterLines.push(`Maybe (${roster.maybe.length}): ${mentions(roster.maybe)}`);
  if (roster.out.length) rosterLines.push(`Out: ${mentions(roster.out)}`);
  if (rosterLines.length) sections.push(rosterLines.join('\n'));

  const line = weatherLine(weather);
  if (line) sections.push(`${DIVIDER}\n${line}`);

  return sections.join('\n\n');
}

export function parseWeatherLine(text) {
  const idx = text.indexOf(DIVIDER);
  if (idx === -1) return null;
  const after = text.slice(idx + DIVIDER.length);
  const match = after.match(/^\n(.+)$/);
  if (!match) return null;
  return match[1];
}

export function parseHeader(text) {
  return text.split('\n', 1)[0];
}
