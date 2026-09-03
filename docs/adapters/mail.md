# Mail

Outbound email leaves the platform one way: a caller hands `MAIL_DISPATCH` a
`{ key, data }` template, the `mail` module enqueues it onto the `mail-send` queue, and
the worker resolves the address, locale and display name, renders once, and sends. See
ADR-0038.

## Interfaces

Source of truth: the mail contract and adapter ports under `packages/core/src/contracts/`.

`EMAIL_SENDER.send({ to, subject, html, text })` - HTML and text are separate fields; the
transport never sniffs one string. `EMAIL_TEMPLATE_RENDERER.render(template, locale)`
returns `{ subject, html, text }`.

## Default bindings

The `mail` module binds both at boot (`packages/core/src/mail/plugin.ts`):

- `EMAIL_SENDER` -> `StdoutEmailSender` (logs metadata, never sends).
- `EMAIL_TEMPLATE_RENDERER` -> `DefaultEmailTemplateRenderer` (English-only plain text
  for every key, with a minimal generated HTML body).

So the platform runs with no operator overlay - it just does not send real mail.

## Operator overlay

An operator overlay rebinds one or both tokens **after** the `mail` plugin. A renderer
overlay adds languages and a designed HTML body; a sender overlay points at a real
provider (SMTP, SES, Postmark).

```ts
// extensions/mail/plugin.ts
import { EMAIL_SENDER, EMAIL_TEMPLATE_RENDERER } from '@openora/core/contracts';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { SmtpSender } from './smtp-sender.js';
import { ReactEmailRenderer } from './react-email-renderer.js';

export default {
  id: 'operator-mail',
  dependsOn: ['mail'],
  register(ctx) {
    ctx.provide(EMAIL_SENDER, () => new SmtpSender(process.env.SMTP_URL));
    ctx.provide(EMAIL_TEMPLATE_RENDERER, () => new ReactEmailRenderer());
  },
} as const satisfies Plugin<CoreTokenCatalog>;
```

Register it in `extensions.config.ts` after the core `mail` entry (`Container` is
last-wins).

## Template keys

`verifyEmail`, `resetPasswordOtp`, `adminResetPasswordOtp`, `existingAccountSignUp`, `rgLimitUpdated`,
`rgCoolingOffActivated`, `rgCoolingOffLifted`, `rgSelfExclusionActivated`,
`rgSelfExclusionLifted`, `withdrawalApproved`, `withdrawalRejected`,
`kycResubmissionRequested`, `adminInvitation`.

An overlay renderer receives every built-in template key and owns the rendered result for each key;
there is no automatic fallback to the platform's English renderer.

## Delivery guarantee

`MAIL_DISPATCH` enqueues (with a short enqueue-retry); the `mail-send` worker retries the
send five times with a growing gap and a bounded concurrency. The durable queue envelope is
authenticated-encrypted with `AUTH_SECRET`, so addresses, OTPs, and invitation tokens are not
readable from the queue backend. For a responsible-gambling or `kycResubmissionRequested`
template the worker writes an `AUDIT_WRITER` entry on both outcomes -
`mail.regulatory_delivery.sent` and `mail.regulatory_delivery.failed`, each carrying the
template key, recipient locale and attempt - because the regulator asks about the
notification at those events.
