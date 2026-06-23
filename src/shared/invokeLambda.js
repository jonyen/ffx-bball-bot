import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

let cachedClient = null;

function getClient() {
  if (!cachedClient) {
    cachedClient = new LambdaClient({});
  }
  return cachedClient;
}

// Fire-and-forget invoke (InvocationType: Event). The call returns as soon as
// the request is queued — it does not wait for the target function to run.
export function invokeAsync({ functionName, payload }) {
  return getClient().send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify(payload ?? {})),
    }),
  );
}
