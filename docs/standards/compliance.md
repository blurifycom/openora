# Compliance

Read this before changing KYC, responsible gambling, or compliance integrations.

- `KYC_STATUS_WRITER` is the only writer of a player's KYC status. Keep the status change, verification history, and audit-visible event in one transaction. Normalize the deprecated `verified` status before comparing an approval state.
- Manual KYC decisions require authorization and a non-empty reason. A manual approval is stored as `manually_overridden`; repeated decisions at the current status create neither history nor another event.
- Verify KYC webhooks before accepting them. Queue vendor resolution off the request path, deduplicate the exact delivery, and reject a decision older than the last accepted delivery for that verification. Retry a decision whose player does not yet exist; do not drop it.
- A vendor approval passes only when every supplied verification check is approved. Missing checks mean the adapter has no check granularity; an empty supplied list or an unknown/non-approved check requires resubmission. Derive checks from the vendor decision, not a duplicated workflow configuration.
- Only duplicate-device and high-risk-country signals trigger the high-risk tag. VPN/Tor and datacenter-IP signals alone do not.
- Responsible-gambling restrictions must block login, revoke active sessions, and reject a new wager server-side. Do not block settlement of an already started round. Cooling-off expiry is evaluated at enforcement time, not by an unblock job.
- Do not write player compliance state directly or bind sealed national-register tokens.
