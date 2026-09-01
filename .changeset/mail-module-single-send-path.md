---
'@openora/core': major
---

Consolidate all outbound email onto one `mail` module and one send path.

**New**

- `mail` module (`@openora/core/mail`, `@openora/core/mail/plugin`): a thin module (no table, no routes) that owns the mail seams and a `mail-send` job queue worker. Rendering and transport happen off the request path, with a retry, a bounded concurrency, and - for the responsible-gambling and KYC-resubmission templates - an audit entry when delivery is finally exhausted.
- `MAIL_DISPATCH` port - the façade every caller uses: `toUser({ userId, template, idempotencyKey })` and `toAddress({ email, locale?, template, idempotencyKey })`. The template is a `{ key, data }` tagged union.
- `EMAIL_SENDER` port - `send({ to, subject, html, text })`. HTML and text are separate fields; the transport never sniffs one string.
- Four template keys: `withdrawalApproved`, `withdrawalRejected`, `kycResubmissionRequested`, `adminInvitation`. Core ships an English plain-text fallback for every key.
- `AdminUserRow.language` on `ADMIN_USER_DIRECTORY`, so a `toUser` send can pick the account locale.

**Breaking**

- `SEND_EMAIL` and `NOTIFICATION_DELIVERY_ADAPTER` are removed. Bind `EMAIL_SENDER` instead (a new name, not a renamed port - the argument shape changed).
- The notification-delivery port no longer has an email method; the notifications module names a mail template and hands it to `MAIL_DISPATCH`.
- `EMAIL_TEMPLATE_RENDERER.render` now takes the `{ key, data }` template whole and returns `{ subject, html, text }` (was `(key, data, locale) => { subject, body }`).
- `CreateAuth`'s `sendEmail` / `templateRenderer` / `getUserLanguage` options are replaced by a single `dispatchOtpMail` hook.

Email date/number formatting now follows the recipient locale instead of a hard-coded `en-GB`.
