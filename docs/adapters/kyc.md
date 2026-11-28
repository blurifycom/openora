# KYC Adapter

## Interface

Source of truth: [`packages/core/src/contracts/adapters/kyc.ts`](../../packages/core/src/contracts/adapters/kyc.ts) - `KycAdapter`, `KycDocument`, `KycVendorStatus`, `KycResult`, and the `KYC_ADAPTER` token.

Every submit and status check carries the caller-chosen `tier`, either `basic` or `advanced` (the player picks it on `submitKyc`; the platform doesn't assign it). An adapter must use it when selecting a provider workflow if its vendor distinguishes workflows. The platform persists the tier independently of the vendor reference, so one vendor workflow can also serve both tiers - when it does, attribute a webhook or resolved decision to one tier whenever the vendor supports that, so reconciliation can scope its write to that tier's row instead of applying the decision to every row sharing the reference. Basic alone controls the player's withdrawal KYC status; Advanced is independently tracked.

Two fields drive behavior beyond their types: `KycAdapter.autoApproves` marks a rubber-stamp adapter (the default `MockKycAdapter`) - a boot guard refuses/warns if withdrawals are KYC-gated while it's bound, so the gate can't be on with verification a no-op; real providers omit it. `KycResult.verificationUrl` is set only by hosted-session vendors whose own page collects documents (see recipe 2), and omitted by document-forwarding vendors.

`KycAdapter.resolveDecision(referenceId)` is an optional method: fetches the full decision
(`status`, `documentTypes`, `decisionReason`) for a reference id. Document-forwarding
vendors and `MockKycAdapter` have nothing to resolve - the webhook/submit payload already
IS the decision - and omit it. A hosted-session vendor (recipe 2) implements it so the
async `kyc-decision-sync` job (below) can enrich a bare webhook `referenceId`+`status`
with the full decision off the request path.

`KycAdapter.resolveRiskSignals(referenceId)` is a second, independent optional method:
fetches vendor-neutral device/IP risk signals (`vpnOrTorDetected`, `dataCenterIpDetected`,
`duplicateDeviceDetected`, `highRiskCountryDetected`, `deviceFingerprints`) for a reference
id. These only exist as part of a vendor's hosted verification session - never at signup -
so only a hosted-session vendor implements it; document-forwarding vendors and
`MockKycAdapter` omit it. The `kyc-decision-sync` job calls it alongside `resolveDecision`
and persists the result on the `kyc_verification` row; see the compliance contract and schema for the
storage and auto-tagging rule.

## Webhook verifier

A second port, `KycWebhookVerifier` + the `KYC_WEBHOOK_VERIFIER` token (same source file), authenticates the vendor's async webhook before `KycAdapter.parseWebhook` ever sees the body.

`verify` takes the full headers map, not a single pre-extracted value - the signing header
name is vendor-specific (SumSub, a hosted-session vendor, and any future provider each name
it differently), so each implementation extracts whatever header(s) it actually needs.

The default binding is `HmacKycWebhookVerifier` (`compliance/adapters/hmac-kyc-webhook-verifier.ts`):
recomputes an HMAC-SHA256 of the raw request body keyed by a configured secret and
constant-time compares it against the `x-kyc-signature` header (case-insensitive lookup;
a leading `sha256=` prefix is tolerated). Fails closed when the secret is unset, the
signature is absent, or the raw body was not captured. `verify` returns `boolean |
Promise<boolean>` (a plain sync `boolean` still satisfies the type) because the default
implementation ALSO enforces replay protection - a signature already accepted within a
10-minute window (via the `CACHE` seam) is rejected, since HMAC alone has no expiry and a
captured valid body+signature would otherwise be replayable forever. A vendor overlay
rebinding `KYC_WEBHOOK_VERIFIER` should carry the same replay guard unless the vendor's
own delivery protocol already provides one; see the compliance service's replay protection
for the full rationale (including why a signed-timestamp check alone is not enough for a
vendor like Didit that signs only the body).

The router (`compliance/router/index.ts`, `kycWebhook` handler) verifies against the
captured `context.rawBody` before calling `kycAdapter.parseWebhook`, then enqueues a
`kyc-decision-sync` job and returns 2xx immediately - it never reconciles inline and never
awaits a vendor call in the request path (a vendor's own webhook SLA, eg Didit's ~5s with
2 retries, must not become ours). The `kyc-decision-sync` worker (`compliance/plugin.ts`)
calls `KycVerificationService.syncDecision`, which resolves the full decision through
`kycAdapter.resolveDecision` when the adapter implements it, then reconciles via
`KycVerificationService.reconcile`. Never trust an unverified webhook body.

## Default binding

The `identity` module ships `MockKycAdapter` (auto-approves all submissions, `autoApproves: true`).
It is bound at boot via `pam/identity/plugin.ts`. This is intentionally permissive for local dev.

## Binding recipe 1: document-forwarding vendor (eg SumSub)

Your backend forwards documents to the vendor and the vendor decides synchronously or via
webhook. `submit()` returns no `verificationUrl` - nothing for the consumer to redirect to.

1. Scaffold an overlay plugin with `pnpm gen plugin`, naming it `sumsub-kyc`.
2. Implement `KycAdapter` against the vendor's REST API. `submit` posts to the vendor's applicant
   API and returns no `verificationUrl`, since the documents were forwarded directly. `getStatus` reads the applicant's review status from the vendor.
   `parseWebhook` normalizes the vendor's webhook payload into referenceId+status, or null. The port
   (`KycAdapter`, with `KycDocument`, `KycResult`, `KycTier`, `KycVendorStatus`) is declared in
   `packages/core/src/contracts/adapters/kyc.ts`; `MockKycAdapter` in
   `packages/core/src/pam/identity/adapters/mock/mock-kyc-adapter.ts` is a working reference.
3. Bind it in the plugin, AFTER `identity` in `extensions.config.ts` (last registration wins).
   The overlay plugin has id `sumsub-kyc`, depends on `identity`, and in `register` provides
   `KYC_ADAPTER` with the new adapter.

4. Register in `extensions.config.ts` **after** the `identity` entry.

## Binding recipe 2: hosted-session vendor (eg Didit or similar)

Your backend calls the vendor to create a verification session; the vendor returns a
hosted URL, and the vendor's own page collects and reviews documents - not your backend.
`submit()` returns `verificationUrl`; the consumer's `submitKyc` response carries it
through so the frontend can redirect the player. The vendor reconciles the outcome later
via webhook, using its own signing header - the webhook only carries a bare
referenceId+status, so implement `resolveDecision` to fetch the full decision
(`documentTypes`, `decisionReason`) the `kyc-decision-sync` job needs; it runs off the
request path, so its vendor round-trip never touches the webhook's SLA.

1. Scaffold an overlay plugin with `pnpm gen plugin`, naming it `hosted-kyc`.
2. Implement `KycAdapter.submit` to create a session and return the hosted URL,
   `parseWebhook` to normalize the vendor's async decision into a bare referenceId+status,
   and `resolveDecision` to fetch the full decision for the `kyc-decision-sync` job.

   `submit` posts to the vendor's create-session API (the vendor collects documents itself) and
   returns the reference id, status `pending` and the hosted `verificationUrl`. `getStatus` reads the
   session's current decision. `parseWebhook` normalizes the vendor's webhook into a bare
   referenceId+status, or null. `resolveDecision` fetches the full decision (referenceId, status,
   `documentTypes`, `decisionReason`); the `kyc-decision-sync` job calls it off the request path,
   never the webhook handler. `resolveRiskSignals` fetches the session decision and extracts
   device and IP risk signals into the vendor-neutral `KycRiskSignals` shape (VPN or Tor, data-center
   IP, duplicate device, high-risk country, device fingerprints); the same job calls it alongside
   `resolveDecision`. All of these are declared on `KycAdapter` in
   `packages/core/src/contracts/adapters/kyc.ts`.

3. Implement `KycWebhookVerifier` if the vendor's signing header differs from
   `x-kyc-signature`, and rebind both tokens together.
   The overlay plugin has its own id, depends on `identity`, and in `register` provides `KYC_ADAPTER`
   with the hosted adapter and `KYC_WEBHOOK_VERIFIER` with a verifier built from the vendor's webhook
   secret (read from env). Both tokens are declared in `packages/core/src/contracts/adapters/`.

4. Register in `extensions.config.ts` **after** the `identity` entry. The consumer's
   frontend calls `submitKyc`, reads `verificationUrl` off the response, and redirects the
   player there; the vendor's webhook later reconciles the final status via
   `POST /compliance/kyc/webhook`.

## Webhook route

`POST /compliance/kyc/webhook` is unauthenticated (M2M, no admin session) and relies
entirely on `KYC_WEBHOOK_VERIFIER` to reject forged calls. It always verifies against the
verbatim captured request bytes (`context.rawBody`) - never a re-serialized body. On a
valid signature it enqueues a `kyc-decision-sync` job and returns 2xx immediately; it
never calls `resolveDecision` or any other vendor API inline.
