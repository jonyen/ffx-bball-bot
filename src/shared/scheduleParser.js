// Pure JS parser for /ball schedule input. No AWS SDK dependency so tests can
// import it directly.
//
// Accepted forms:
//   cron(0 8 ? * TUE,THU *)           → verbatim
//   rate(1 hour)                      → verbatim
//   at(2026-04-11T08:00:00)           → verbatim
//   0 8 ? * TUE,THU *                 → wrapped as cron(...)
//   every Tuesday and Thursday at 8am → natural language
//   every weekday at 9:30am
//   every day at noon
//   mon,wed,fri at 7am
//
// Returns { expression, summary, kind }; throws on unparseable input with a
// user-friendly message.

const DAY_ALIASES = {
  sun: 'SUN', sunday: 'SUN', sundays: 'SUN',
  mon: 'MON', monday: 'MON', mondays: 'MON',
  tue: 'TUE', tues: 'TUE', tuesday: 'TUE', tuesdays: 'TUE',
  wed: 'WED', weds: 'WED', wednesday: 'WED', wednesdays: 'WED',
  thu: 'THU', thur: 'THU', thurs: 'THU', thursday: 'THU', thursdays: 'THU',
  fri: 'FRI', friday: 'FRI', fridays: 'FRI',
  sat: 'SAT', saturday: 'SAT', saturdays: 'SAT',
};

const DOW_ORDER = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function looksLikeBareCron(text) {
  const fields = text.split(/\s+/);
  if (fields.length !== 6) return false;
  if (!fields.every((f) => /^[0-9A-Z*?,/\-]+$/i.test(f))) return false;
  // Require at least one cron-specific token so a six-word English sentence
  // ("every Tuesday and Thursday at 8am") doesn't get mis-wrapped as cron(...).
  return fields.some((f) => /[*?/\-]/.test(f));
}

function extractTime(text) {
  if (/\bnoon\b/.test(text)) return { hour: 12, minute: 0 };
  if (/\bmidnight\b/.test(text)) return { hour: 0, minute: 0 };

  // 12-hour with meridiem: "8am", "8:30pm", "08:30 am"
  const withMeridiem = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text);
  if (withMeridiem) {
    let hour = parseInt(withMeridiem[1], 10);
    const minute = withMeridiem[2] ? parseInt(withMeridiem[2], 10) : 0;
    const mer = withMeridiem[3].toLowerCase();
    if (mer === 'pm' && hour !== 12) hour += 12;
    if (mer === 'am' && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
  }

  // 24-hour "HH:MM" — colon required so we don't grab stray digits.
  const h24 = /\b(\d{1,2}):(\d{2})\b/.exec(text);
  if (h24) {
    const hour = parseInt(h24[1], 10);
    const minute = parseInt(h24[2], 10);
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
  }

  return null;
}

function extractDays(text) {
  if (/\bweekdays?\b/i.test(text)) return ['MON', 'TUE', 'WED', 'THU', 'FRI'];
  if (/\bweekends?\b/i.test(text)) return ['SAT', 'SUN'];
  if (/\b(every\s*day|everyday|daily)\b/i.test(text)) {
    return ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  }

  const found = new Set();
  for (const [name, canonical] of Object.entries(DAY_ALIASES)) {
    const re = new RegExp(`\\b${name}\\b`, 'i');
    if (re.test(text)) found.add(canonical);
  }
  if (found.size === 0) return null;
  return DOW_ORDER.filter((d) => found.has(d));
}

function compactDayField(days) {
  if (days.length === 7) return '*';
  const set = new Set(days);
  if (
    set.size === 5 &&
    ['MON', 'TUE', 'WED', 'THU', 'FRI'].every((d) => set.has(d))
  ) {
    return 'MON-FRI';
  }
  return days.join(',');
}

function formatTime({ hour, minute }) {
  if (hour === 12 && minute === 0) return 'noon';
  if (hour === 0 && minute === 0) return 'midnight';
  const h12 = ((hour + 11) % 12) + 1;
  const mer = hour < 12 ? 'am' : 'pm';
  const mm = minute.toString().padStart(2, '0');
  return minute === 0 ? `${h12}${mer}` : `${h12}:${mm}${mer}`;
}

function describeDays(dowField, days) {
  if (dowField === '*') return 'every day';
  if (dowField === 'MON-FRI') return 'every weekday';
  if (dowField === 'SAT,SUN') return 'every weekend';
  return `every ${days.join(', ')}`;
}

function parseNatural(text) {
  const lower = text.toLowerCase();
  const time = extractTime(lower);
  if (!time) {
    throw new Error(
      `Couldn't find a time in "${text}". Try "every Tue, Thu at 8am".`,
    );
  }
  const days = extractDays(lower);
  if (!days || days.length === 0) {
    throw new Error(
      `Couldn't find any days in "${text}". Try "every Tue, Thu at 8am".`,
    );
  }
  const dowField = compactDayField(days);
  const expression = `cron(${time.minute} ${time.hour} ? * ${dowField} *)`;
  const summary = `${describeDays(dowField, days)} at ${formatTime(time)}`;
  return { expression, summary, kind: 'natural' };
}

export function parseScheduleInput(input) {
  const trimmed = (input ?? '').trim();
  if (!trimmed) {
    throw new Error('Schedule expression is empty.');
  }

  if (/^(cron|rate|at)\s*\(/i.test(trimmed)) {
    return { expression: trimmed, summary: trimmed, kind: 'raw' };
  }

  if (looksLikeBareCron(trimmed)) {
    const expression = `cron(${trimmed})`;
    return { expression, summary: expression, kind: 'cron' };
  }

  return parseNatural(trimmed);
}
