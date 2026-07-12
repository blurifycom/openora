# Notifications

In-app notification log + optional email delivery. Table: `notification` (userId, type, title, body, readAt timestamp). `type` is the contract-surface `NOTIFICATION_TYPES` triple (`contract/index.ts`) - currently `withdrawal.approved`/`withdrawal.rejected`, the only values a creation site emits. Routes: `list` (player), `markRead` (player), `markAllRead` (player).

Subscribes to `wallet.withdrawal.approved` and `wallet.withdrawal.rejected` events; creates in-app notification + triggers email via `NOTIFICATION_DELIVERY_ADAPTER`. Email is best-effort (missing user or delivery failure logged, never throws) - the in-app notification lands first and always succeeds. Resolves player email via `ADMIN_USER_DIRECTORY` (owned by identity module); depends on identity for that port.

Event handler defers email send to a background promise (catches and logs) so a delivery hang doesn't block the event handler. On delivery failure, a warning log includes the userId for ops to investigate.

## Audit

`create` emits `notifications.created`, subscribed by the `audit` module (`audit/plugin.ts`) - the notification's creation is audited as a system-generated record (recipient carried in `after.userId`, not as an actor).

`markRead`/`markAllRead` are a deliberate non-audited exception: they only flip a player's own `readAt` on their own notification (ownership-checked, no cross-user effect, no money/config/compliance impact) - not the kind of state change the DoD's "money/KYC/config change" bar targets.
