import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  log,
  metric,
  withCorrelationId,
  getCorrelationId,
  METRIC_NAMESPACE,
} from '../src/shared/logger.js';

function lastLine(spy) {
  return JSON.parse(spy.mock.calls.at(-1)[0]);
}

describe('structured logging', () => {
  let out;
  let err;

  beforeEach(() => {
    out = vi.spyOn(console, 'log').mockImplementation(() => {});
    err = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('emits one JSON object per line', () => {
    log.info('roll call posted', { channel: 'C1' });

    expect(out).toHaveBeenCalledTimes(1);
    const line = lastLine(out);
    expect(line.level).toBe('info');
    expect(line.message).toBe('roll call posted');
    expect(line.channel).toBe('C1');
    expect(typeof line.ts).toBe('string');
  });

  test('errors go to stderr so CloudWatch separates them', () => {
    log.error('slack rejected the post', { code: 'channel_not_found' });

    expect(err).toHaveBeenCalledTimes(1);
    expect(out).not.toHaveBeenCalled();
    expect(lastLine(err).code).toBe('channel_not_found');
  });

  test('serializes an Error rather than logging an empty object', () => {
    log.error('boom', { error: new Error('weather api blew up') });

    const line = lastLine(err);
    expect(line.error.message).toBe('weather api blew up');
    expect(line.error.name).toBe('Error');
    expect(typeof line.error.stack).toBe('string');
  });

  test('never throws on a value that cannot be serialized', () => {
    const circular = {};
    circular.self = circular;

    expect(() => log.info('circular', { circular })).not.toThrow();
    expect(out).toHaveBeenCalledTimes(1);
  });
});

describe('correlation id', () => {
  let out;

  beforeEach(() => {
    out = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('tags every line emitted inside the scope', async () => {
    await withCorrelationId('abc-123', async () => {
      log.info('first');
      log.info('second');
    });

    expect(JSON.parse(out.mock.calls[0][0]).correlationId).toBe('abc-123');
    expect(JSON.parse(out.mock.calls[1][0]).correlationId).toBe('abc-123');
  });

  test('is absent outside any scope', () => {
    log.info('untagged');
    expect(lastLine(out).correlationId).toBeUndefined();
  });

  test('restores the previous id after the scope exits', async () => {
    await withCorrelationId('outer', async () => {
      await withCorrelationId('inner', async () => {
        expect(getCorrelationId()).toBe('inner');
      });
      expect(getCorrelationId()).toBe('outer');
    });
    expect(getCorrelationId()).toBeUndefined();
  });

  test('restores the previous id even when the body throws', async () => {
    await expect(
      withCorrelationId('doomed', async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');

    expect(getCorrelationId()).toBeUndefined();
  });
});

describe('metrics (CloudWatch EMF)', () => {
  let out;

  beforeEach(() => {
    out = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('emits an EMF envelope CloudWatch can parse', () => {
    metric('RollCallPosted', 1, { unit: 'Count', dimensions: { Lambda: 'postMessage' } });

    const line = lastLine(out);
    const emf = line._aws.CloudWatchMetrics[0];

    expect(emf.Namespace).toBe(METRIC_NAMESPACE);
    expect(emf.Metrics).toEqual([{ Name: 'RollCallPosted', Unit: 'Count' }]);
    expect(emf.Dimensions).toEqual([['Lambda']]);
    expect(line.RollCallPosted).toBe(1);
    expect(line.Lambda).toBe('postMessage');
    expect(typeof line._aws.Timestamp).toBe('number');
  });

  test('defaults to a count of one', () => {
    metric('ReactionProcessed');
    expect(lastLine(out).ReactionProcessed).toBe(1);
  });

  test('supports non-count units for latency', () => {
    metric('WeatherFetchMs', 250, { unit: 'Milliseconds' });
    expect(lastLine(out)._aws.CloudWatchMetrics[0].Metrics[0].Unit).toBe('Milliseconds');
  });

  test('carries the correlation id so a metric ties back to its run', async () => {
    await withCorrelationId('run-9', async () => {
      metric('RollCallPosted');
    });
    expect(lastLine(out).correlationId).toBe('run-9');
  });

  test('emits no dimension array when none are given', () => {
    metric('Standalone');
    expect(lastLine(out)._aws.CloudWatchMetrics[0].Dimensions).toEqual([[]]);
  });
});
