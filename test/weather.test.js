import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchWeather, pickIcon, noonEtMsFor } from '../src/postMessage/weather.js';

describe('pickIcon', () => {
  test.each([
    ['Sunny', '☀️'],
    ['Clear', '☀️'],
    ['Partly Sunny', '⛅'],
    ['Mostly Sunny', '⛅'],
    ['Partly Cloudy', '⛅'],
    ['Mostly Cloudy', '☁️'],
    ['Cloudy', '☁️'],
    ['Overcast', '☁️'],
    ['Light Rain', '🌧️'],
    ['Rain Showers', '🌧️'],
    ['Slight Chance Showers And Thunderstorms', '⛈️'],
    ['Chance Drizzle', '🌧️'],
    ['Snow', '❄️'],
    ['Sleet', '❄️'],
    ['Thunderstorms', '⛈️'],
    ['Fog', '🌫️'],
    ['Haze', '🌫️'],
    ['', '🌡️'],
  ])('maps %s to %s', (shortForecast, icon) => {
    expect(pickIcon(shortForecast)).toBe(icon);
  });
});

describe('noonEtMsFor', () => {
  test('returns noon EDT (16:00 UTC) during daylight-saving time', () => {
    const now = new Date('2026-04-10T13:00:00Z'); // 9am EDT
    const result = noonEtMsFor(now);
    expect(new Date(result).toISOString()).toBe('2026-04-10T16:00:00.000Z');
  });

  test('returns noon EST (17:00 UTC) during standard time', () => {
    const now = new Date('2026-01-15T13:00:00Z'); // 8am EST
    const result = noonEtMsFor(now);
    expect(new Date(result).toISOString()).toBe('2026-01-15T17:00:00.000Z');
  });

  test('uses the ET calendar date, not the UTC one, near midnight', () => {
    // 02:00 UTC on Apr 11 is still 22:00 EDT on Apr 10
    const now = new Date('2026-04-11T02:00:00Z');
    const result = noonEtMsFor(now);
    expect(new Date(result).toISOString()).toBe('2026-04-10T16:00:00.000Z');
  });
});

describe('fetchWeather', () => {
  const ORIGINAL_FETCH = globalThis.fetch;
  const POINTS_URL = 'https://api.weather.gov/points/38.887947,-77.275015';
  const HOURLY_URL = 'https://api.weather.gov/gridpoints/LWX/96,70/forecast/hourly';

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  function mockNws(periods, { forecastHourlyUrl = HOURLY_URL } = {}) {
    globalThis.fetch.mockImplementation(async (url) => {
      if (url === POINTS_URL) {
        return {
          ok: true,
          json: async () => ({ properties: { forecastHourly: forecastHourlyUrl } }),
        };
      }
      if (url === forecastHourlyUrl) {
        return {
          ok: true,
          json: async () => ({ properties: { periods } }),
        };
      }
      return { ok: false, status: 404 };
    });
  }

  function period(startTime, temperature, shortForecast) {
    return { startTime, temperature, temperatureUnit: 'F', shortForecast };
  }

  test('calls NWS points endpoint for Nottoway Park, then follows the forecastHourly URL', async () => {
    mockNws([period('2026-04-14T12:00:00-04:00', 79, 'Sunny')]);

    await fetchWeather();

    const urls = globalThis.fetch.mock.calls.map((c) => c[0]);
    expect(urls[0]).toBe(POINTS_URL);
    expect(urls[1]).toBe(HOURLY_URL);
  });

  test('sends the User-Agent header NWS requires', async () => {
    mockNws([period('2026-04-14T12:00:00-04:00', 79, 'Sunny')]);

    await fetchWeather();

    const init = globalThis.fetch.mock.calls[0][1];
    expect(init.headers['User-Agent']).toBeTruthy();
    expect(init.headers.Accept).toContain('geo+json');
  });

  test('picks the hourly period closest to noon ET on the current ET day', async () => {
    const now = new Date('2026-04-14T13:00:00Z'); // 9am EDT
    mockNws([
      period('2026-04-14T08:00:00-04:00', 67, 'Sunny'),         // 8am EDT
      period('2026-04-14T11:00:00-04:00', 74, 'Sunny'),         // 11am EDT
      period('2026-04-14T12:00:00-04:00', 79, 'Sunny'),         // noon EDT ← target
      period('2026-04-14T13:00:00-04:00', 82, 'Partly Sunny'),  // 1pm EDT
    ]);

    const result = await fetchWeather({ now });

    expect(result).toEqual({ icon: '☀️', tempF: 79, description: 'Sunny' });
  });

  test('with target:"now" picks the hourly period closest to now', async () => {
    const now = new Date('2026-04-14T23:30:00Z'); // 7:30pm EDT
    mockNws([
      period('2026-04-14T12:00:00-04:00', 79, 'Sunny'),
      period('2026-04-14T19:00:00-04:00', 68, 'Cloudy'),        // 7pm EDT ← closest
      period('2026-04-14T21:00:00-04:00', 62, 'Rain Showers'),
    ]);

    const result = await fetchWeather({ now, target: 'now' });

    expect(result).toEqual({ icon: '☁️', tempF: 68, description: 'Cloudy' });
  });

  test('rounds temperature', async () => {
    const now = new Date('2026-04-14T13:00:00Z');
    mockNws([period('2026-04-14T12:00:00-04:00', 72.6, 'Sunny')]);

    const result = await fetchWeather({ now });

    expect(result.tempF).toBe(73);
  });

  test('returns null when the points endpoint responds non-ok', async () => {
    globalThis.fetch.mockResolvedValue({ ok: false, status: 500 });
    const result = await fetchWeather();
    expect(result).toBeNull();
  });

  test('returns null when the hourly endpoint responds non-ok', async () => {
    globalThis.fetch.mockImplementation(async (url) => {
      if (url === POINTS_URL) {
        return {
          ok: true,
          json: async () => ({ properties: { forecastHourly: HOURLY_URL } }),
        };
      }
      return { ok: false, status: 500 };
    });
    const result = await fetchWeather();
    expect(result).toBeNull();
  });

  test('returns null when fetch throws', async () => {
    globalThis.fetch.mockRejectedValue(new Error('network down'));
    const result = await fetchWeather();
    expect(result).toBeNull();
  });

  test('returns null when the hourly periods list is empty', async () => {
    mockNws([]);
    const result = await fetchWeather();
    expect(result).toBeNull();
  });

  test('passes an AbortSignal to every fetch', async () => {
    mockNws([period('2026-04-14T12:00:00-04:00', 79, 'Sunny')]);

    await fetchWeather();

    for (const call of globalThis.fetch.mock.calls) {
      const init = call[1];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  test('aborts when the timeoutMs option elapses', async () => {
    vi.useFakeTimers();
    let capturedSignal;
    globalThis.fetch.mockImplementation((_url, init) => {
      capturedSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    });

    const pending = fetchWeather({ timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    const result = await pending;

    expect(result).toBeNull();
    expect(capturedSignal.aborted).toBe(true);
    vi.useRealTimers();
  });
});
