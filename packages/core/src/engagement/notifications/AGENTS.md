# Notifications

In-app notification log with optional email delivery, driven by the wallet withdrawal approved/rejected events. `type` is the `NOTIFICATION_TYPES` contract triple - only values a creation site actually emits belong in it. Player emails resolve through `ADMIN_USER_DIRECTORY` (owned by identity), never by reading identity tables.

## Invariants

- The in-app record is authoritative and always lands; email through `NOTIFICATION_DELIVERY_ADAPTER` is best-effort - a missing user or failed delivery is logged with the userId for ops, never thrown.
- The event handler fires the email on a detached, caught promise so a hung delivery can't stall event processing.
- `create` emits `notifications.created` for the audit module: a system-generated record, recipient in `after.userId`, no actor.
- `markRead`/`markAllRead` are a deliberate audit exception - a player flipping `readAt` on their own row has no money/KYC/config effect.
