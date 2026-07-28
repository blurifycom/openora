# Notifications

In-app notification log with optional email delivery, driven by the wallet withdrawal approved/rejected events and by compliance's KYC resubmission requests. `type` is the `NOTIFICATION_TYPES` contract triple (`withdrawal.approved`/`withdrawal.rejected`/`kyc.resubmission_requested`) - only values a creation site actually emits belong in it. Player emails resolve through `ADMIN_USER_DIRECTORY` (owned by identity), never by reading identity tables.

## Invariants

- The in-app record is authoritative and always lands; email through `NOTIFICATION_DELIVERY_ADAPTER` is best-effort - a missing user or failed delivery is logged with the userId for ops, never thrown.
- The event handler fires the email on a detached, caught promise so a hung delivery can't stall event processing.
- `create` emits `notifications.created` for the audit module: a system-generated record, recipient in `after.userId`, no actor.
- `markRead`/`markAllRead` are a deliberate audit exception - a player flipping `readAt` on their own row has no money/KYC/config effect.

## KYC resubmission notification (JOB_QUEUE-backed)

Subscribes to compliance's `compliance.kyc.updated`, filtered to `status: 'resubmission_requested'` + `source: 'manual'` - covering both `compliance.requestKycResubmission` and an `overrideKycStatus` call that lands on the same target status, since both write through the same `KYC_STATUS_WRITER` emit. Unlike the withdrawal handlers, this one enqueues a `kyc-resubmission-notify` job (`JOB_QUEUE`) instead of dispatching inline: an admin action must never block on a slow SMTP endpoint (ADR-0014). The worker (registered in this same `plugin.ts`) creates the in-app notification and sends the email. The job's `idempotencyKey` is the envelope's `eventId` - unique per emit, stable across a redelivery of the SAME event once a durable broker is bound; never `Date.now()`, which would make every enqueue unique and defeat dedup. Compliance never imports this module - the domain event is the only coupling.
