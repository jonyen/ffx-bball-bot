// Structured logging and metrics.
//
// Every line is a single JSON object so CloudWatch Logs Insights can query
// fields directly instead of regexing prose. Metrics ride along in the same
// line using CloudWatch's Embedded Metric Format, which means no PutMetricData
// call, no added latency on the request path, and no per-metric API cost.

import { AsyncLocalStorage } from 'node:async_hooks';

export const METRIC_NAMESPACE = 'FfxBballBot';

const correlationStore = new AsyncLocalStorage();

/**
 * Run `fn` with every log line and metric tagged by `id`.
 *
 * AsyncLocalStorage rather than a module-level variable: Lambda reuses a warm
 * container across invocations, and concurrent async work inside one
 * invocation would otherwise interleave and cross-tag each other's lines.
 */
export function withCorrelationId(id, fn) {
  return correlationStore.run(id, fn);
}

export function getCorrelationId() {
  return correlationStore.getStore();
}

function serializeError(err) {
  return { name: err.name, message: err.message, stack: err.stack };
}

function replacer() {
  const seen = new WeakSet();
  return (_key, value) => {
    if (value instanceof Error) return serializeError(value);
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    if (typeof value === 'bigint') return value.toString();
    return value;
  };
}

/**
 * Never let logging take down the caller. A log line that cannot be
 * serialized is worth degrading, not throwing over.
 */
function write(stream, payload) {
  let line;
  try {
    line = JSON.stringify(payload, replacer());
  } catch {
    line = JSON.stringify({
      level: 'error',
      message: 'logger: payload could not be serialized',
      ts: new Date().toISOString(),
    });
  }
  stream(line);
}

function emit(level, message, fields = {}) {
  const correlationId = getCorrelationId();
  write(level === 'error' ? console.error : console.log, {
    level,
    message,
    ts: new Date().toISOString(),
    ...(correlationId ? { correlationId } : {}),
    ...fields,
  });
}

export const log = {
  info: (message, fields) => emit('info', message, fields),
  warn: (message, fields) => emit('warn', message, fields),
  error: (message, fields) => emit('error', message, fields),
};

/**
 * Emit a CloudWatch metric embedded in a log line.
 *
 * Keep dimension cardinality low — CloudWatch bills per unique dimension
 * combination, so channel IDs and user IDs belong in fields, not dimensions.
 */
export function metric(name, value = 1, { unit = 'Count', dimensions = {}, fields = {} } = {}) {
  const correlationId = getCorrelationId();
  const dimensionNames = Object.keys(dimensions);

  write(console.log, {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: METRIC_NAMESPACE,
          Dimensions: [dimensionNames],
          Metrics: [{ Name: name, Unit: unit }],
        },
      ],
    },
    ...(correlationId ? { correlationId } : {}),
    ...dimensions,
    ...fields,
    [name]: value,
  });
}
