import { and, eq, sql } from 'drizzle-orm';
import { eventOutbox, type DrizzleDb } from '@openora/core/server';
import { capturedEmailsFor } from './captured-emails.js';
import { readJson } from './helpers.js';
import type { TestClient } from './request.js';

/** What the player sees after a staff KYC resubmission request, shared by the KYC e2e suites. */
export const BASIC_SUBJECT = 'Document resubmission required';
export const ADVANCED_SUBJECT = 'Additional verification required';

// The event -> notify job -> mail job pipeline crosses Redis twice; vi.waitFor's 1s default is
// too tight for it under a parallel run.
export const PIPELINE_WAIT = { timeout: 10_000, interval: 100 };

type NotificationItem = { type: string; params: Record<string, string> | null };

export async function resubmissionNotifications(client: TestClient): Promise<NotificationItem[]> {
  const { items } = await readJson(await client.get('/notifications'));
  return (items as NotificationItem[]).filter((n) => n.type === 'kyc.resubmission_requested');
}

export function resubmissionEmails(to: string) {
  return capturedEmailsFor(to).filter(
    (m) => m.subject === BASIC_SUBJECT || m.subject === ADVANCED_SUBJECT,
  );
}

/**
 * Absence checks: gives the event -> job -> mail pipeline time to (not) deliver. A fixed wait,
 * because the harness's BullMQ queue and Redis Streams broker expose no drain or idle hook.
 */
export async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

/**
 * The `compliance.kyc.updated` resubmission requests committed for `userId`. The event is written
 * to the outbox in the request's own transaction, so an empty result once the request has answered
 * means no notification or email can follow it.
 */
export function resubmissionRequestEvents(db: DrizzleDb, userId: string) {
  return db
    .select({ eventId: eventOutbox.eventId })
    .from(eventOutbox)
    .where(
      and(
        eq(eventOutbox.topic, 'compliance.kyc.updated'),
        sql`${eventOutbox.payload}->>'userId' = ${userId}`,
        sql`${eventOutbox.payload}->>'status' = 'resubmission_requested'`,
      ),
    );
}
