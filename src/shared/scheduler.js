import {
  SchedulerClient,
  GetScheduleCommand,
  UpdateScheduleCommand,
} from '@aws-sdk/client-scheduler';

let cachedClient = null;

function getClient() {
  if (!cachedClient) {
    cachedClient = new SchedulerClient({});
  }
  return cachedClient;
}

export function getSchedule({ name, groupName = 'default' }) {
  return getClient().send(
    new GetScheduleCommand({ Name: name, GroupName: groupName }),
  );
}

export function updateSchedule({
  name,
  groupName = 'default',
  scheduleExpression,
  scheduleExpressionTimezone,
  flexibleTimeWindow,
  target,
  state,
}) {
  return getClient().send(
    new UpdateScheduleCommand({
      Name: name,
      GroupName: groupName,
      ScheduleExpression: scheduleExpression,
      ScheduleExpressionTimezone: scheduleExpressionTimezone,
      FlexibleTimeWindow: flexibleTimeWindow,
      Target: target,
      State: state,
    }),
  );
}
