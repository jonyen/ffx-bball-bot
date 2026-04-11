import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchWeather, pickIcon, noonEtMsFor } from '../src/postMessage/weather.js';

describe('pickIcon', () => {
  test.each([
    ['Clear', '☀️'],
    ['Clouds', '☁️'],
    ['Rain', '🌧️'],
    ['Drizzle', '🌧️'],
    ['Snow', '❄️'],
    ['Thunderstorm', '⛈️'],
    ['Mist', '🌡️'],
    ['Haze', '🌡️'],
    ['', '🌡️'],
  ])('maps %s to %s', (main, icon) => {
    expect(pickIcon(main)).toBe(icon);
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

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  function forecastResponse(list) {
    return { ok: true, json: async () => ({ list }) };
  }

  function entry(dtUnix, tempF, main, description) {
    return {
      dt: dtUnix,
      main: { temp: tempF },
      weather: [{ main, description }],
    };
  }

  test('calls OpenWeatherMap forecast endpoint with Fairfax coordinates and imperial units', async () => {
    globalThis.fetch.mockResolvedValue(
      forecastResponse([entry(0, 60, 'Clear', 'clear sky')]),
    );

    await fetchWeather('api-key');

    const url = globalThis.fetch.mock.calls[0][0];
    expect(url).toContain('/data/2.5/forecast');
    expect(url).toContain('lat=38.8462');
    expect(url).toContain('lon=-77.3064');
    expect(url).toContain('units=imperial');
    expect(url).toContain('appid=api-key');
  });

  test('picks the forecast entry closest to noon ET on the current ET day', async () => {
    const now = new Date('2026-04-10T13:00:00Z'); // 9am EDT
    const noonUnix = new Date('2026-04-10T16:00:00Z').getTime() / 1000;

    globalThis.fetch.mockResolvedValue(
      forecastResponse([
        entry(noonUnix - 2 * 3600, 50, 'Rain', 'light rain'),
        entry(noonUnix, 65, 'Clear', 'clear sky'),
        entry(noonUnix + 2 * 3600, 70, 'Clouds', 'broken clouds'),
      ]),
    );

    const result = await fetchWeather('api-key', { now });

    expect(result).toEqual({
      icon: '☀️',
      tempF: 65,
      description: 'Clear sky',
    });
  });

  test('picks the nearest entry by time difference when none is exactly at noon', async () => {
    const now = new Date('2026-04-10T13:00:00Z');
    const noonUnix = new Date('2026-04-10T16:00:00Z').getTime() / 1000;

    globalThis.fetch.mockResolvedValue(
      forecastResponse([
        entry(noonUnix - 3600, 60, 'Rain', 'light rain'),     // 11am ET, 1hr away
        entry(noonUnix + 2 * 3600, 75, 'Clear', 'clear sky'), // 2pm ET, 2hr away
      ]),
    );

    const result = await fetchWeather('api-key', { now });

    expect(result.tempF).toBe(60);
    expect(result.description).toBe('Light rain');
  });

  test('handles EST (non-DST) correctly', async () => {
    const now = new Date('2026-01-15T13:00:00Z'); // 8am EST
    const noonUnix = new Date('2026-01-15T17:00:00Z').getTime() / 1000;

    globalThis.fetch.mockResolvedValue(
      forecastResponse([
        entry(noonUnix - 2 * 3600, 30, 'Snow', 'light snow'),
        entry(noonUnix, 35, 'Clear', 'clear sky'),
        entry(noonUnix + 2 * 3600, 40, 'Clouds', 'few clouds'),
      ]),
    );

    const result = await fetchWeather('api-key', { now });

    expect(result).toEqual({
      icon: '☀️',
      tempF: 35,
      description: 'Clear sky',
    });
  });

  test('with target:"now" picks the forecast entry closest to now instead of noon ET', async () => {
    // now = 7:30pm EDT on 2026-04-10 (23:30 UTC)
    const now = new Date('2026-04-10T23:30:00Z');
    const noonUnix = new Date('2026-04-10T16:00:00Z').getTime() / 1000; // noon EDT
    const sixPmUnix = new Date('2026-04-10T22:00:00Z').getTime() / 1000; // 6pm EDT
    const ninePmUnix = new Date('2026-04-11T01:00:00Z').getTime() / 1000; // 9pm EDT

    globalThis.fetch.mockResolvedValue(
      forecastResponse([
        entry(noonUnix, 72, 'Clear', 'clear sky'),
        entry(sixPmUnix, 65, 'Clouds', 'broken clouds'),
        entry(ninePmUnix, 58, 'Rain', 'light rain'),
      ]),
    );

    const result = await fetchWeather('api-key', { now, target: 'now' });

    // 7:30pm is 1.5h from 6pm and 1.5h from 9pm — ties break to first encountered (6pm)
    expect(result).toEqual({
      icon: '☁️',
      tempF: 65,
      description: 'Broken clouds',
    });
  });

  test('target:"noon" (default) still targets noon ET even when now is in the evening', async () => {
    const now = new Date('2026-04-10T23:30:00Z'); // 7:30pm EDT
    const noonUnix = new Date('2026-04-10T16:00:00Z').getTime() / 1000;
    const eveningUnix = new Date('2026-04-10T23:00:00Z').getTime() / 1000;

    globalThis.fetch.mockResolvedValue(
      forecastResponse([
        entry(noonUnix, 72, 'Clear', 'clear sky'),
        entry(eveningUnix, 60, 'Rain', 'light rain'),
      ]),
    );

    const result = await fetchWeather('api-key', { now });

    expect(result.tempF).toBe(72);
    expect(result.description).toBe('Clear sky');
  });

  test('rounds temperature and capitalizes description', async () => {
    const now = new Date('2026-04-10T13:00:00Z');
    const noonUnix = new Date('2026-04-10T16:00:00Z').getTime() / 1000;

    globalThis.fetch.mockResolvedValue(
      forecastResponse([entry(noonUnix, 72.4, 'Rain', 'light rain')]),
    );

    const result = await fetchWeather('api-key', { now });

    expect(result.tempF).toBe(72);
    expect(result.description).toBe('Light rain');
  });

  test('returns null when the API responds with a non-ok status', async () => {
    globalThis.fetch.mockResolvedValue({ ok: false, status: 500 });
    const result = await fetchWeather('api-key');
    expect(result).toBeNull();
  });

  test('returns null when fetch throws', async () => {
    globalThis.fetch.mockRejectedValue(new Error('network down'));
    const result = await fetchWeather('api-key');
    expect(result).toBeNull();
  });

  test('returns null when the forecast list is empty', async () => {
    globalThis.fetch.mockResolvedValue(forecastResponse([]));
    const result = await fetchWeather('api-key');
    expect(result).toBeNull();
  });

  test('passes an AbortSignal', async () => {
    globalThis.fetch.mockResolvedValue(
      forecastResponse([entry(0, 60, 'Clouds', 'overcast clouds')]),
    );

    await fetchWeather('api-key');

    const init = globalThis.fetch.mock.calls[0][1];
    expect(init).toBeDefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
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

    const pending = fetchWeather('api-key', { timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    const result = await pending;

    expect(result).toBeNull();
    expect(capturedSignal.aborted).toBe(true);
    vi.useRealTimers();
  });
});
