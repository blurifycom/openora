# ADR-0038: Mail Module and a Single Outbound-Mail Path

**Date**: 2026-09-01
**Status**: Accepted

## Context

Outbound email left the platform three different ways. The identity OTP hook rendered
and sent inside the request. `compliance/rg.service` rendered, sent, and swallowed the
error in `logger.warn`. The notifications module carried a `sendEmail: boolean` flag and
mailed the in-app notification's English body. None of the three had a delivery
guarantee, and four of the twelve template keys did not know the recipient's language -
date formatting was hard-coded to `en-GB`.

The two ports it went through - `SEND_EMAIL` (identity) and
`NOTIFICATION_DELIVERY_ADAPTER` (notifications) - both existed only to move an email, with
different argument shapes, and an operator had to bind both.

A binding for the send path cannot live in `identity` or `notifications`: `notifications`
depends on `identity`, and `identity` needs to send mail, so a mail binding in either
closes a load-order cycle.

## Decision

### One module

`packages/core/src/mail/` is a thin domain (module id `mail`, published as
`@openora/core/mail` + `/plugin` + `/contract`). It owns **no table and no HTTP
routes** - only the mail seams and one `mail-send` job queue worker. `#110` already
built the queue-layer machinery for notifications (idempotency key from
`envelope.eventId`, five tries with a growing gap, an `onDeadLetter` hook); the mail
worker mirrors that shape rather than reimplementing it.

### No `dependsOn`, lazy resolution

The mail plugin declares no `dependsOn`. Every consumer resolves `MAIL_DISPATCH` lazily
in its own router factory, which runs after every plugin has registered - the same
pattern `wallet/plugin.ts` uses for `TAG_EVALUATION_COMMANDS`. The `MailService` is
memoized on first `MAIL_DISPATCH` resolution. It is deliberate, and it is why the plugin
can bind a port `identity` needs while `identity` binds ports the mail worker needs.

The worker itself needs the `MailService`, and the BullMQ worker starts consuming the
moment it is registered - before router factories run, and in a `mail`-only split
deployment no consumer resolves `MAIL_DISPATCH` at all. So the mail plugin registers an
**empty router** whose only job is to force `mailService(c)` during the boot-time router
loop, before the first job is picked up. `identity` and `iam` (which resolve
`MAIL_DISPATCH` unconditionally) declare `requiresPorts: [MAIL_DISPATCH]`, so a split
deployment that omits `mail` fails fast with a descriptive boot error (ADR-0024) rather
than a bare "no provider" crash.

### One transport port

`EMAIL_SENDER` (`send({ to, subject, html, text })`) replaces both `SEND_EMAIL` and
`NOTIFICATION_DELIVERY_ADAPTER`. HTML and text are separate fields, so the operator's
transport never sniffs `body.trim().startsWith('<')`. This is a new name, not a renamed
port: an operator gets a compile error, not a silently different argument shape under a
familiar name. Push and SMS are out of scope (`SMS_ADAPTER` already lives separately).

### One facade

`MAIL_DISPATCH` with `toUser({ userId, template, idempotencyKey })` and
`toAddress({ email, locale?, template, idempotencyKey })`. It never sends inline - each
call enqueues onto `mail-send`. The template is a `{ key, data }` tagged union: a bare
generic over the key would not narrow `data` to one payload, which is exactly what forced
the auth hook into three explicit branches. `toAddress` exists because the auth OTP hook
and the admin-invitation flow hold an address, not a user id - and a "you already have an
account" mail to an existing address must never confirm the account exists.

`toAddress`'s `locale` is optional; when absent the mail module falls back to `'en'`.
The mail module never reads the identity schema, so `identity` resolves the account
locale in its OTP hook and passes it explicitly. Admin invitations are always English
(no account yet; the back-office ships `en` only).

### Regulatory audit on every regulatory send

The worker writes an `AUDIT_WRITER` entry for the five responsible-gambling keys and
`kycResubmissionRequested` - on a successful send (`mail.regulatory_delivery.sent`) and
on an exhausted one (`mail.regulatory_delivery.failed`), and only for those keys. The
regulator asks separately about the notification at an RG or KYC event ("the player was
told"), so the delivered case is the primary evidence and the failed case records that
it could not be produced. Each entry carries the template key, the recipient locale and
the attempt number. A withdrawal is not in this set - it already has an audit entry on
the decision itself.

### Interim guard for the ack gap

`compliance/rg.service`'s `notify()` used a bare `.catch(log)`. The broker itself is
untouched; the `MAIL_DISPATCH` enqueue is retried a few times with a short gap before it
gives up. The durable fix - an outbox row written in the caller's own transaction, with
the queue as an accelerator - is a later ticket; the platform already has an outbox for
events.

## Consequences

- Three breaking changes: transport ports consolidated, the notification-delivery port
  loses its email method, the renderer return shape changes to `{ subject, html, text }`
  and its input to the `{ key, data }` template.
- Core still ships an English-only plain-text fallback for every template key, so the
  platform runs with no operator renderer.
- Rendering happens only in the worker, never during a request.
- The Redis service in `docker-compose.yml` and in the consumer templates gets an
  fsync'd append-only journal and a volume - a restart no longer drops what is queued.
  A dedicated queue instance stays a later infra ticket.
