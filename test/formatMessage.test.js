import { describe, test, expect } from 'vitest';
import {
  formatMessage,
  parseWeatherLine,
  parseHeader,
} from '../src/shared/formatMessage.js';

const WEATHER = {
  icon: '☀️',
  tempF: 72,
  description: 'Clear sky',
};

const EMPTY = { in: [], out: [], maybe: [] };

describe('formatMessage', () => {
  test('initial message (no reactions) includes weather', () => {
    const msg = formatMessage(EMPTY, WEATHER);
    expect(msg).toBe(
      '🏀 today?\n\n──────────────\n☀️ Fairfax, VA — 72°F, Clear sky',
    );
  });

  test('initial message with null weather omits the weather block', () => {
    const msg = formatMessage(EMPTY, null);
    expect(msg).toBe('🏀 today?');
  });

  test('renders users as slack mentions with a count on the In line', () => {
    const msg = formatMessage(
      { in: ['U1', 'U2'], out: [], maybe: [] },
      WEATHER,
    );
    expect(msg).toContain('In (2): <@U1>, <@U2>');
  });

  test('only shows categories that have members', () => {
    const msg = formatMessage(
      { in: ['U1'], out: [], maybe: [] },
      WEATHER,
    );
    expect(msg).toContain('In (1): <@U1>');
    expect(msg).not.toContain('Out:');
    expect(msg).not.toContain('Maybe:');
  });

  test('shows all three categories when populated', () => {
    const msg = formatMessage(
      { in: ['U1'], out: ['U2'], maybe: ['U3'] },
      WEATHER,
    );
    expect(msg).toContain('In (1): <@U1>');
    expect(msg).toContain('Maybe (1): <@U3>');
    expect(msg).toContain('Out: <@U2>');
  });

  test('full message with reactions matches the spec example', () => {
    const msg = formatMessage(
      { in: ['U123', 'U456'], out: ['U789'], maybe: ['U012'] },
      WEATHER,
    );
    expect(msg).toBe(
      '🏀 today?\n\n' +
        'In (2): <@U123>, <@U456>\n' +
        'Maybe (1): <@U012>\n' +
        'Out: <@U789>\n\n' +
        '──────────────\n' +
        '☀️ Fairfax, VA — 72°F, Clear sky',
    );
  });

  test('with reactions but null weather still renders the roster', () => {
    const msg = formatMessage({ in: ['U1'], out: [], maybe: [] }, null);
    expect(msg).toBe('🏀 today?\n\nIn (1): <@U1>');
  });
});

describe('parseWeatherLine', () => {
  test('extracts the weather line from a formatted message', () => {
    const msg =
      '🏀 today?\n\nIn (1): <@U1>\n\n──────────────\n☀️ Fairfax, VA — 72°F, Clear sky';
    expect(parseWeatherLine(msg)).toBe('☀️ Fairfax, VA — 72°F, Clear sky');
  });

  test('extracts the weather line from an initial (no-reaction) message', () => {
    const msg = '🏀 today?\n\n──────────────\n☀️ Fairfax, VA — 72°F, Clear sky';
    expect(parseWeatherLine(msg)).toBe('☀️ Fairfax, VA — 72°F, Clear sky');
  });

  test('returns null when the message has no weather block', () => {
    const msg = '🏀 today?\n\nIn (1): <@U1>';
    expect(parseWeatherLine(msg)).toBeNull();
  });
});

describe('formatMessage with raw weather line', () => {
  test('accepts a pre-formatted weather line string', () => {
    const rawLine = '🌧️ Fairfax, VA — 58°F, Light rain';
    const msg = formatMessage({ in: ['U1'], out: [], maybe: [] }, rawLine);
    expect(msg).toBe(
      '🏀 today?\n\nIn (1): <@U1>\n\n──────────────\n🌧️ Fairfax, VA — 58°F, Light rain',
    );
  });
});

describe('formatMessage with custom header', () => {
  test('uses the supplied header verbatim, with no auto-prepended emoji', () => {
    const msg = formatMessage(EMPTY, WEATHER, {
      headerText: 'tonight at 7pm? — <@U123>',
    });
    expect(msg).toBe(
      'tonight at 7pm? — <@U123>\n\n──────────────\n☀️ Fairfax, VA — 72°F, Clear sky',
    );
  });

  test('preserves a basketball already in the supplied header', () => {
    const msg = formatMessage(EMPTY, null, {
      headerText: '🏀 tonight at 7pm? — <@U123>',
    });
    expect(msg).toBe('🏀 tonight at 7pm? — <@U123>');
  });

  test('custom header with reactions and null weather', () => {
    const msg = formatMessage(
      { in: ['U1'], out: [], maybe: [] },
      null,
      { headerText: 'pickup at the park' },
    );
    expect(msg).toBe('pickup at the park\n\nIn (1): <@U1>');
  });

  test('empty headerText falls back to the default', () => {
    const msg = formatMessage(EMPTY, null, { headerText: '' });
    expect(msg).toBe('🏀 today?');
  });

  test('undefined headerText uses the default', () => {
    const msg = formatMessage(EMPTY, null, {});
    expect(msg).toBe('🏀 today?');
  });
});

describe('parseHeader', () => {
  test('returns the first line of a multi-line message', () => {
    expect(parseHeader('🏀 today?\n\n──────────────\n☀️ weather')).toBe('🏀 today?');
  });

  test('preserves a custom slash-command header with attribution', () => {
    const msg =
      '🏀 tonight at 7pm? — <@U123>\n\nIn (1): <@U1>\n\n──────────────\n☀️ weather';
    expect(parseHeader(msg)).toBe('🏀 tonight at 7pm? — <@U123>');
  });

  test('handles a single-line message with no trailing newline', () => {
    expect(parseHeader('🏀 today?')).toBe('🏀 today?');
  });

  test('returns headers without a basketball emoji as-is', () => {
    expect(parseHeader('tonight at 7pm (Alice)\n\nIn (1): <@U1>')).toBe(
      'tonight at 7pm (Alice)',
    );
  });

  test('preserves the :basketball: shortcode form that Slack stores', () => {
    expect(parseHeader(':basketball: today?')).toBe(':basketball: today?');
  });
});
