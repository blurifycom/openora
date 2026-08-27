# Compliance

Read this before changing KYC, responsible gambling, or compliance integrations.

- `KYC_STATUS_WRITER` is the only writer of a player's KYC status. Keep the status change, verification history, and audit-visible event in one transaction. Normalize the deprecated `verified` status before comparing an approval state.
- Manual KYC decisions require authorization and a non-empty reason. A manual approval is stored as `manually_overridden`; repeated decisions at the current status create neither history nor another event.
- Verify KYC webhooks before accepting them. Queue vendor resolution off the request path, deduplicate the exact delivery, and reject a decision older than the last accepted delivery for that verification. Retry a decision whose player does not yet exist; do not drop it.
- A vendor approval passes only when every supplied verification check is approved. Missing checks mean the adapter has no check granularity; an empty supplied list or an unknown/non-approved check requires resubmission. Derive checks from the vendor decision, not a duplicated workflow configuration.
- Only duplicate-device and high-risk-country signals trigger the high-risk tag. VPN/Tor and datacenter-IP signals alone do not.
- Responsible-gambling restrictions must block login, revoke active sessions, and reject a new wager server-side. Do not block settlement of an already started round. Cooling-off expiry is evaluated at enforcement time, not by an unblock job.
- A money limit is enforced, not only flagged. Refuse a deposit before the PSP call and a `bet` debit at the amount, both through `RG_LIMITS`; resolve the port optionally (`c.has`) and fail closed where it is bound. An on-chain crypto deposit is credited and flagged rather than refused - the funds are already on the chain - and player-facing copy must say so.
- Weakening a limit - raising it or removing it - waits out the configured cool-down and then requires the player's own confirmation. Nothing else may raise a limit: reads never promote a pending change and the expiry sweep only clears one. Setting a first limit, lowering one, and cancelling a request all apply immediately.
- Attribute every RG action to whoever took it. Carry `initiatedBy` on the event and record the audit actor from it; never assume an admin.
- Do not write player compliance state directly or bind sealed national-register tokens.
