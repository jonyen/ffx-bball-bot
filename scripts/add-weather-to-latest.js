#!/usr/bin/env node
// One-shot: find the most recent bot message in each SLACK_CHANNELS entry
// and re-render it with the current weather appended. Preserves the existing
// header line; re-derives the roster from current reactions.
//
// Usage: node scripts/add-weather-to-latest.js

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, '..', '.env');

if (!existsSync(envPath)) {
  console.error(`No .env file at ${envPath}`);
  process.exit(1);
}

process.loadEnvFile(envPath);

const required = ['SLACK_BOT_TOKEN', 'SLACK_CHANNELS', 'SLACK_BOT_USER_ID'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const { fetchWeather } = await import('../src/postMessage/weather.js');
const { formatMessage, parseHeader } = await import('../src/shared/formatMessage.js');
const { categorize } = await import('../src/reactionHandler/categorize.js');
const {
  getChannelHistory,
  getReactions,
  updateMessage,
  parseChannels,
} = await import('../src/shared/slack.js');

const token = process.env.SLACK_BOT_TOKEN;
const botUserId = process.env.SLACK_BOT_USER_ID;
const channels = parseChannels(process.env.SLACK_CHANNELS);

const weather = await fetchWeather({ timeoutMs: 8000, target: 'noon' });
if (!weather) {
  console.error('✗ weather fetch returned null — aborting');
  process.exit(1);
}
console.log(`weather: ${weather.icon} ${weather.tempF}°F ${weather.description}`);

for (const channel of channels) {
  try {
    const history = await getChannelHistory({ token, channel, limit: 20 });
    const target = (history.messages ?? []).find((m) => m.user === botUserId);
    if (!target) {
      console.log(`${channel}: no recent bot message, skipping`);
      continue;
    }

    const { message } = await getReactions({ token, channel, ts: target.ts });
    const roster = categorize(message?.reactions ?? [], botUserId);
    const headerText = parseHeader(target.text ?? '');

    const text = formatMessage(roster, weather, { headerText });
    await updateMessage({ token, channel, ts: target.ts, text });
    console.log(`${channel}: updated ts=${target.ts}`);
  } catch (err) {
    console.error(`${channel}: failed — ${err.message}`);
  }
}
