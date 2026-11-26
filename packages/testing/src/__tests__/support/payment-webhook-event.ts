import type { PaymentWebhookEvent } from '@openora/core/contracts';

const KINDS: readonly unknown[] = ['deposit', 'deposit_status', 'withdrawal'];

function isPaymentWebhookEvent(value: unknown): value is PaymentWebhookEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    KINDS.includes(value.kind) &&
    'externalId' in value &&
    typeof value.externalId === 'string'
  );
}

export function parseTestWebhook(rawBody: string): PaymentWebhookEvent {
  const value: unknown = JSON.parse(rawBody);
  if (isPaymentWebhookEvent(value)) {
    return value;
  }
  throw new Error('test webhook body is not a payment event');
}
