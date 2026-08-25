# ADR-0036: Admin session security as an opt-in policy port

**Date**: 2026-08-25
**Status**: Proposed

## Context

Operators under a gambling licence are expected to enforce two-factor authentication on
every back-office account and to tie an admin session to the device it was issued to.
The platform already carried the parts - better-auth's `twoFactor()` plugin, a
`two_factor` table, enable/verify/disable routes and an audit subscription - but nothing
that made a second factor mandatory, nothing that bound a session to a device, and no way
to grant a trusted-device window that could later be revoked.

Three constraints shaped the design:

- `AdminGuard` is the single enforcement point for admin routes, but it lives in the
  engine zone and may not import PAM tables (ADR-0019/0025).
- The platform is consumed by operators under different licences. Whether back-office 2FA
  is mandatory is their decision, not the framework's, and an enforcement default that
  flips on during an upgrade would lock a running deployment out of its own back office.
- better-auth issues an opaque trusted-device cookie. Nothing can enumerate or revoke it,
  which is incompatible with a regulator asking who trusted what and when.

## Decision

Enforcement lives behind `ADMIN_SECURITY_POLICY`, a port `AdminGuard` resolves optionally
and the identity module binds. The guard calls `assertEnrolled` and `assertSessionIntact`
after its existing role and permission checks; both throw rather than return a verdict, so
a caller cannot forget to branch and silently grant access.

The policy is configured through `PlatformConfig.adminSecurity` and every enforcing switch
defaults to off (`requireTwoFactor: false`, `bindSessionToDevice: false`,
`ipChangePolicy: 'off'`). An operator opts in; the platform ships the capability, not the
obligation.

A trusted device requires two independent facts: better-auth's cookie AND an unrevoked row
in `admin_trusted_device`. Revoking the row forces a second factor on the next request.

A session fingerprint compares the request's User-Agent against the session's, normalised
to major versions so a browser auto-update does not end every session. IP is judged by
`ipChangePolicy`; `country` resolves through `GEO_IP_ADAPTER` and degrades to `off` when no
adapter is bound, never to `any`.

Failed second factors are counted in `user` columns separate from the password-login
counters. The pending user is resolved from the two-factor verification row, because
better-auth withholds the session until the factor clears and a failing attempt would
otherwise have no account to charge.

## Consequences

**Positive:**

- One enforcement point covers every admin route, including routes added later.
- The engine zone stays free of PAM imports; the policy is swappable like any other port.
- A trusted-device window is listable, auditable and revocable, which is what a licence
  review asks for.
- Existing deployments upgrade with no behaviour change.

**Negative / trade-offs:**

- Resolving the pending user reads a verification row whose identifier format
  (`2fa-<random>`) is better-auth's internal detail. A format change degrades the account
  lockout to the existing per-attempt rate limit rather than breaking the flow, but it is a
  place to check when better-auth is upgraded.
- Every admin request now performs one session lookup; the activity write is throttled, the
  read is not.
- User-Agent is trivially forged. Session binding raises the cost of using a stolen cookie
  from a different client; it is not a defence against an attacker who replays the original
  header.
