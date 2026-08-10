# Runbook

What the alarms mean and what to do about them. Alarms post to the Slack
channel set by `ALARM_CHANNEL`; the SNS topic behind them is
`ffx-bball-alarms`, and its ARN is a stack output.

## Service level objective

**99% of scheduled roll calls post to every target channel, measured monthly.**

The bot posts twice a week, so a month holds roughly 9 scheduled roll calls
across each channel. One missed post is already a bad month — the objective is
deliberately strict because the failure is highly visible: people show up to a
court, or don't.

The SLI is the `FfxBballBot/RollCallPosted` metric, not Lambda success. A
Lambda that finishes cleanly having posted nothing is a failure by this
definition, and that gap is exactly what `roll-call-missing` exists to catch.

## Reading the logs

Every line is JSON, and every line from one invocation carries the same
`correlationId` (the Lambda request id). To follow a single run end to end:

```
fields @timestamp, level, message, channel, error.message
| filter correlationId = "<id from the alarm or an error line>"
| sort @timestamp asc
```

To find recent failures across all functions:

```
fields @timestamp, @log, message, error.message
| filter level = "error"
| sort @timestamp desc
| limit 50
```

---

## `ffx-bball-roll-call-missing`

**Means:** no roll call posted for five consecutive days.

**Why five:** posts land Tuesday and Thursday, so the longest healthy gap is
Thursday to Tuesday — four zero days (Fri, Sat, Sun, Mon). Five is the smallest
window that cannot false-fire. The cost is latency: a schedule that dies after
a Thursday post surfaces the following Wednesday. CloudWatch alarms cannot
express day-of-week, so tightening this means moving the check into code.

**Diagnose, in order:**

1. **Did the schedule fire?** Check EventBridge Scheduler `ffx-bball-post-schedule`
   — is it enabled, and what is its `ScheduleExpression`? `/ball schedule` can
   change this at runtime, and `deploy.sh` deliberately preserves the live value,
   so it may not match the template default.
2. **Did the Lambda run?** Invocations on `ffx-bball-post-message` around the
   expected time. None means the schedule or its IAM role is the problem.
3. **Did it throw?** Filter the logs for `level = "error"` in that window.
4. **Did Slack reject it?** Look for `roll call post failed` and its `error.message`
   — `channel_not_found` or `not_in_channel` means the bot was removed from a
   channel, `invalid_auth` means the token was rotated or revoked.

**Fix:** re-enable or correct the schedule; re-invite the bot; refresh
`SLACK_BOT_TOKEN` and redeploy. To post immediately rather than waiting for the
next window, use `/ball`.

## `ffx-bball-roll-call-failures`

**Means:** a roll call posted to some channels but failed on at least one. The
scheduler and Lambda are fine; one destination is not.

**Diagnose:** find `roll call post failed` and read `channel` and
`error.message`. Almost always the bot was removed from that channel, or the
channel was archived.

**Fix:** re-invite the bot, or drop the channel from `SLACK_CHANNELS` and
redeploy. Note this alarm does not auto-resolve on a good run — clear it once
the cause is fixed.

## `ffx-bball-function-errors`

**Means:** `ffx-bball-post-message` threw.

Note this fires only on a *total* failure, because the handler rethrows only
when every channel failed. Partial failures surface as
`roll-call-failures` instead.

**Diagnose:** the failure DM to `FAILURE_DM_USER` usually arrives first and
carries the context. Otherwise filter the logs by `level = "error"`.

## `ffx-bball-slash-command-slow`

**Means:** `/ball` p99 has been above 2.5s for two consecutive periods, against
Slack's hard 3s deadline. Past that, the user sees `operation_timeout` even
though the command actually worked.

**Diagnose:** weather is the usual culprit. The slash path already uses a 2s
weather timeout versus 8s for the scheduled post; if the provider is slow,
latency approaches the ceiling anyway.

**Fix:** short term, nothing — it degrades to posting without the weather line.
If it persists, drop the weather timeout further or make the slash path skip
weather entirely and edit it in afterward, which is what `WeatherEditFunction`
already exists to do.

---

## Adding an alert path that survives a Slack outage

Alarms reach Slack through a Lambda that calls Slack. If Slack is the outage,
the notification cannot land. SNS is fan-out, so an independent path costs one
command:

```bash
aws sns subscribe \
  --topic-arn "$(aws cloudformation describe-stacks --stack-name <stack> \
      --query 'Stacks[0].Outputs[?OutputKey==`AlarmTopicArn`].OutputValue' --output text)" \
  --protocol email --notification-endpoint you@example.com
```

## Deploying

```bash
./scripts/deploy.sh
```

Requires `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_BOT_USER_ID`,
`SLACK_CHANNELS`, `FAILURE_DM_USER`, and `ALARM_CHANNEL`. The script preserves
the live `ScheduleExpression` so a runtime `/ball schedule` change is not
clobbered.
