// Posts CloudWatch alarm state changes into Slack.
//
// Deliberately its own Lambda subscribed to an SNS topic rather than something
// the bot calls: the alarms that matter most are the ones firing because the
// bot is broken, so the alert path must not share the bot's code path. SNS is
// also fan-out, so an email subscription can be added to the same topic
// without touching this function — worth doing, since a Slack outage is
// exactly when this notifier cannot deliver.

import { postMessage } from '../shared/slack.js';
import { log } from '../shared/logger.js';

function format(message) {
  let alarm;
  try {
    alarm = JSON.parse(message);
  } catch {
    return `⚠️ Alarm notification\n\`\`\`\n${message}\n\`\`\``;
  }

  if (!alarm || typeof alarm !== 'object' || !alarm.AlarmName) {
    return `⚠️ Alarm notification\n\`\`\`\n${message}\n\`\`\``;
  }

  const firing = alarm.NewStateValue === 'ALARM';
  const icon = firing ? '🔴' : alarm.NewStateValue === 'OK' ? '✅' : 'ℹ️';
  const verb = firing ? 'FIRING' : alarm.NewStateValue === 'OK' ? 'RESOLVED' : alarm.NewStateValue;

  const lines = [`${icon} *${verb}* — \`${alarm.AlarmName}\``];
  if (alarm.AlarmDescription) lines.push(alarm.AlarmDescription);
  if (alarm.NewStateReason) lines.push(`\n_${alarm.NewStateReason}_`);
  if (alarm.Trigger?.MetricName) {
    lines.push(`\nMetric: \`${alarm.Trigger.Namespace}/${alarm.Trigger.MetricName}\``);
  }
  lines.push('\nRunbook: `docs/RUNBOOK.md`');

  return lines.join('\n');
}

export async function handler(event) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.ALARM_CHANNEL;
  const records = event?.Records ?? [];

  // ALARM_CHANNEL is optional, so the alarm still reaches SNS (and any email
  // subscriber) even when Slack relay is not configured. Log the alarm rather
  // than dropping it silently.
  if (!channel) {
    for (const record of records) {
      log.warn('ALARM_CHANNEL is unset; alarm not relayed to Slack', {
        alarm: record?.Sns?.Message,
      });
    }
    return;
  }

  // allSettled, not all: one undeliverable alarm must not swallow the others.
  await Promise.allSettled(
    records.map(async (record) => {
      const text = format(record?.Sns?.Message ?? '');
      try {
        await postMessage({ token, channel, text });
      } catch (error) {
        // Nothing left to escalate to — log loudly and let the Lambda succeed
        // so SNS does not retry into a Slack outage.
        log.error('alarm notification could not be delivered', { error, text });
      }
    }),
  );
}
