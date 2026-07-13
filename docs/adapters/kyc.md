# KYC Adapter

## Interface

```ts
// packages/core/src/contracts/adapters/kyc.ts
export type KycAdapter = {
  // True when the adapter rubber-stamps every submission (the default MockKycAdapter).
  // A boot guard refuses/warns if withdrawals are KYC-gated while this is bound, so an
  // operator can't enable the gate yet leave verification a no-op. Real providers omit it.
  readonly autoApproves?: boolean;
  submit(userId: string, documents: KycDocument[]): Promise<KycResult>;
  getStatus(userId: string): Promise<KycVendorStatus>;
  // Provider-specific normalization of a raw webhook into a vendor decision, or null when
  // the body is not a reconcilable decision. Optional - MockKycAdapter omits it.
  parseWebhook?(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): KycResult | null;
};

export type KycDocument = {
  type: 'passport' | 'drivers_license' | 'national_id';
  frontUrl: string;
  backUrl?: string;
};

export type KycVendorStatus = 'pending' | 'approved' | 'rejected' | 'not_started';

export type KycResult = {
  referenceId: string;
  status: KycVendorStatus;
  // Hosted verification URL to redirect the end user to, for vendors whose flow collects
  // documents on their own hosted page rather than accepting them from our backend.
  // Omitted by document-forwarding vendors (eg SumSub, MockKycAdapter).
  verificationUrl?: string;
};

export const KYC_ADAPTER: Token<KycAdapter> = createToken('KYC_ADAPTER');
```

`KYC_ADAPTER` is a `Token<T>` created via `createToken` (`packages/core/src/contracts/adapters/token.ts`),
not a bare `Symbol` - the `Container` uses it to type both `provide` and `get` calls.

## Webhook verifier

A second port authenticates the vendor's async webhook before `KycAdapter.parseWebhook`
ever sees the body:

```ts
export type KycWebhookVerifier = {
  verify(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean;
};

export const KYC_WEBHOOK_VERIFIER: Token<KycWebhookVerifier> = createToken('KYC_WEBHOOK_VERIFIER');
```

`verify` takes the full headers map, not a single pre-extracted value - the signing header
name is vendor-specific (SumSub, a hosted-session vendor, and any future provider each name
it differently), so each implementation extracts whatever header(s) it actually needs.

The default binding is `HmacKycWebhookVerifier` (`compliance/adapters/hmac-kyc-webhook-verifier.ts`):
recomputes an HMAC-SHA256 of the raw request body keyed by a configured secret and
constant-time compares it against the `x-kyc-signature` header (case-insensitive lookup;
a leading `sha256=` prefix is tolerated). Fails closed when the secret is unset, the
signature is absent, or the raw body was not captured. A vendor overlay rebinds
`KYC_WEBHOOK_VERIFIER` alongside `KYC_ADAPTER` when the vendor signs differently.

The router (`compliance/router/index.ts`, `kycWebhook` handler) verifies against the
captured `context.rawBody` before calling `kycAdapter.parseWebhook`, and reconciles via
`KycVerificationService.reconcile` on a decision. Never trust an unverified webhook body.

## Default binding

The `identity` module ships `MockKycAdapter` (auto-approves all submissions, `autoApproves: true`).
It is bound at boot via `pam/identity/plugin.ts`. This is intentionally permissive for local dev.

## Binding recipe 1: document-forwarding vendor (eg SumSub)

Your backend forwards documents to the vendor and the vendor decides synchronously or via
webhook. `submit()` returns no `verificationUrl` - nothing for the consumer to redirect to.

1. Create an overlay plugin:

```bash
pnpm gen plugin sumsub-kyc
```

2. Implement `KycAdapter` against the vendor's REST API:

```ts
// extensions/sumsub-kyc/src/sumsub-kyc-adapter.ts
import type { KycAdapter, KycDocument, KycResult, KycVendorStatus } from '@openora/core/contracts';

export class SumsubKycAdapter implements KycAdapter {
  async submit(userId: string, documents: KycDocument[]): Promise<KycResult> {
    // POST to the vendor's applicant API; no verificationUrl - documents were forwarded directly.
  }

  async getStatus(userId: string): Promise<KycVendorStatus> {
    // GET applicant review status from the vendor.
  }

  parseWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): KycResult | null {
    // normalize the vendor's webhook payload into { referenceId, status }
  }
}
```

3. Bind it in the plugin, AFTER `identity` in `extensions.config.ts` (last registration wins):

```ts
// extensions/sumsub-kyc/plugin.ts
import { KYC_ADAPTER } from '@openora/core/contracts';
import { definePlugin } from '@openora/core/server';
import { SumsubKycAdapter } from './src/sumsub-kyc-adapter.js';

export default definePlugin({
  id: 'sumsub-kyc',
  dependsOn: ['identity'],
  register(ctx) {
    ctx.provide(KYC_ADAPTER, () => new SumsubKycAdapter());
  },
});
```

4. Register in `extensions.config.ts` **after** the `identity` entry.

## Binding recipe 2: hosted-session vendor (eg Didit or similar)

Your backend calls the vendor to create a verification session; the vendor returns a
hosted URL, and the vendor's own page collects and reviews documents - not your backend.
`submit()` returns `verificationUrl`; the consumer's `submitKyc` response carries it
through so the frontend can redirect the player. The vendor reconciles the outcome later
via webhook, using its own signing header.

1. Create an overlay plugin:

```bash
pnpm gen plugin hosted-kyc
```

2. Implement `KycAdapter.submit` to create a session and return the hosted URL, and
   `parseWebhook` to normalize the vendor's async decision:

```ts
// extensions/hosted-kyc/src/hosted-kyc-adapter.ts
import type { KycAdapter, KycDocument, KycResult, KycVendorStatus } from '@openora/core/contracts';

export class HostedKycAdapter implements KycAdapter {
  async submit(userId: string, _documents: KycDocument[]): Promise<KycResult> {
    // POST to the vendor's "create session" API; the vendor collects documents itself.
    // return { referenceId: session.id, status: 'pending', verificationUrl: session.url };
  }

  async getStatus(userId: string): Promise<KycVendorStatus> {
    // GET the session's current decision from the vendor.
  }

  parseWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): KycResult | null {
    // normalize the vendor's webhook payload into { referenceId, status }
  }
}
```

3. Implement `KycWebhookVerifier` if the vendor's signing header differs from
   `x-kyc-signature`, and rebind both tokens together:

```ts
// extensions/hosted-kyc/plugin.ts
import { KYC_ADAPTER, KYC_WEBHOOK_VERIFIER } from '@openora/core/contracts';
import { definePlugin } from '@openora/core/server';
import { HostedKycAdapter } from './src/hosted-kyc-adapter.js';
import { HostedKycWebhookVerifier } from './src/hosted-kyc-webhook-verifier.js';

export default definePlugin({
  id: 'hosted-kyc',
  dependsOn: ['identity'],
  register(ctx) {
    ctx.provide(KYC_ADAPTER, () => new HostedKycAdapter());
    ctx.provide(
      KYC_WEBHOOK_VERIFIER,
      () => new HostedKycWebhookVerifier(process.env.HOSTED_KYC_WEBHOOK_SECRET),
    );
  },
});
```

4. Register in `extensions.config.ts` **after** the `identity` entry. The consumer's
   frontend calls `submitKyc`, reads `verificationUrl` off the response, and redirects the
   player there; the vendor's webhook later reconciles the final status via
   `POST /compliance/kyc/webhook`.

## Webhook route

`POST /compliance/kyc/webhook` is unauthenticated (M2M, no admin session) and relies
entirely on `KYC_WEBHOOK_VERIFIER` to reject forged calls. It always verifies against the
verbatim captured request bytes (`context.rawBody`) - never a re-serialized body.
