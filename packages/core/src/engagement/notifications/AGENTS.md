# Notifications

In-app notification log + optional email delivery. Table: `notification` (userId, type, title, body, readAt timestamp). Routes: `list` (player), `markRead` (player).

Subscribes to `wallet.withdrawal.approved` and `wallet.withdrawal.rejected` events; creates in-app notification + triggers email via `NOTIFICATION_DELIVERY_ADAPTER`. Email is best-effort (missing user or delivery failure logged, never throws) - the in-app notification lands first and always succeeds. Resolves player email via `ADMIN_USER_DIRECTORY` (owned by identity module); depends on identity for that port.

Event handler defers email send to a background promise (catches and logs) so a delivery hang doesn't block the event handler. On delivery failure, a warning log includes the userId for ops to investigate.
