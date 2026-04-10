import crypto from 'node:crypto';

const MAX_SKEW_SECONDS = 5 * 60;

export function verifySignature({ body, timestamp, signature, secret }) {
  if (!signature || !timestamp || !secret) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > MAX_SKEW_SECONDS) return false;

  const base = `v0:${ts}:${body}`;
  const expected =
    'v0=' + crypto.createHmac('sha256', secret).update(base).digest('hex');

  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}
