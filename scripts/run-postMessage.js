#!/usr/bin/env node
// Local runner for the postMessage Lambda.
// Loads .env from the project root, invokes the handler, prints the result.
// Usage: node scripts/run-postMessage.js

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, '..', '.env');

if (!existsSync(envPath)) {
  console.error(`No .env file at ${envPath}`);
  console.error('Copy .env.example to .env and fill in your credentials.');
  process.exit(1);
}

process.loadEnvFile(envPath);

const required = ['SLACK_BOT_TOKEN', 'SLACK_CHANNELS'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

if (!process.env.OPENWEATHERMAP_API_KEY) {
  console.warn('OPENWEATHERMAP_API_KEY not set — message will post without weather.');
}

const { handler } = await import('../src/postMessage/handler.js');

console.log(`Posting to ${process.env.SLACK_CHANNELS}...`);

try {
  const result = await handler({});
  console.log('✓ posted');
  console.log(`  ts:      ${result.ts}`);
  console.log(`  channel: ${result.channel}`);
} catch (err) {
  console.error('✗ failed:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
}
