import { createHmac } from 'node:crypto';

export function signWebhookPayload(payload: string, secret: string): string {
  const timestamp = Date.now().toString();
  const signedPayload = `${timestamp}.${payload}`;
  const signature = createHmac('sha256', secret).update(signedPayload).digest('hex');

  return `t=${timestamp}, v1=${signature}`;
}
