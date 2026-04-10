import { describe, test, expect } from 'vitest';
import crypto from 'node:crypto';
import { verifySignature } from '../src/reactionHandler/verifySignature.js';

const SECRET = 'test-signing-secret';

function sign(timestamp, body, secret = SECRET) {
  const base = `v0:${timestamp}:${body}`;
  return 'v0=' + crypto.createHmac('sha256', secret).update(base).digest('hex');
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

describe('verifySignature', () => {
  test('accepts a valid signature with a fresh timestamp', () => {
    const ts = nowSeconds();
    const body = '{"event":"reaction_added"}';
    const sig = sign(ts, body);
    expect(verifySignature({ body, timestamp: ts, signature: sig, secret: SECRET })).toBe(true);
  });

  test('rejects a tampered body', () => {
    const ts = nowSeconds();
    const body = '{"event":"reaction_added"}';
    const sig = sign(ts, body);
    const tampered = '{"event":"reaction_removed"}';
    expect(verifySignature({ body: tampered, timestamp: ts, signature: sig, secret: SECRET })).toBe(false);
  });

  test('rejects a signature computed with a different secret', () => {
    const ts = nowSeconds();
    const body = '{"event":"reaction_added"}';
    const sig = sign(ts, body, 'wrong-secret');
    expect(verifySignature({ body, timestamp: ts, signature: sig, secret: SECRET })).toBe(false);
  });

  test('rejects stale timestamps (> 5 minutes old)', () => {
    const ts = nowSeconds() - 60 * 6;
    const body = '{"event":"reaction_added"}';
    const sig = sign(ts, body);
    expect(verifySignature({ body, timestamp: ts, signature: sig, secret: SECRET })).toBe(false);
  });

  test('rejects future-dated timestamps (> 5 minutes ahead)', () => {
    const ts = nowSeconds() + 60 * 6;
    const body = '{"event":"reaction_added"}';
    const sig = sign(ts, body);
    expect(verifySignature({ body, timestamp: ts, signature: sig, secret: SECRET })).toBe(false);
  });

  test('rejects missing signature', () => {
    const ts = nowSeconds();
    expect(verifySignature({ body: '{}', timestamp: ts, signature: undefined, secret: SECRET })).toBe(false);
  });

  test('rejects malformed signature (length mismatch does not throw)', () => {
    const ts = nowSeconds();
    expect(verifySignature({ body: '{}', timestamp: ts, signature: 'v0=abc', secret: SECRET })).toBe(false);
  });

  test('accepts timestamp within 5 minute window', () => {
    const ts = nowSeconds() - 60 * 4;
    const body = '{"event":"reaction_added"}';
    const sig = sign(ts, body);
    expect(verifySignature({ body, timestamp: ts, signature: sig, secret: SECRET })).toBe(true);
  });
});
