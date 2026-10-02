# ADR-0041: A redirected country is admitted by the API, and held to its mirror by the consumer

**Date**: 2026-10-02
**Status**: Accepted

## Context

A country rule can blacklist a country and, separately, redirect it to a mirror: another origin
serving the same product, which the operator may run for that market. A blacklisted country with
a mirror in force is meant to play there, not to be turned away.

The country decision (`ComplianceService.geoCheck`, behind registration, login, game launch and
`GET /compliance/geo-check`) sees only the caller's address. It cannot tell a request that arrived
through the mirror from one that arrived through the primary domain: player traffic reaches the
API through each web tier's own same-origin proxy, so the API sees the same request either way.

That leaves two places the "mirror only" rule could live. The API could deny the country and let
the mirror through by some marker the mirror adds, which would have to be unforgeable from the
primary domain and would put origin routing into core. Or the API could admit the country and
leave keeping it off the primary domain to whoever serves that domain, which already knows its
own host.

## Decision

A blacklisted country with a mirror in force (`redirectIp` on and `mirrorUrl` set) is **allowed**
by the country decision, on every path. Holding it to the mirror is the consumer's job:

- `geoCheck` and `GEO_CHECK_COMMANDS.checkAccess` carry the mirror as `redirectUrl`, so a consumer
  can redirect a page request and refuse a session that is not on that origin.
- Every admission of a blacklisted country through a mirror on a session-issuing path emits
  `compliance.geo.access_redirected`, audited as a `geo-access` row, so the access is on record
  even though it is not a denial.
- An unresolved address stays denied while any block rule exists, a redirected one included:
  without a country there is no mirror to send the visitor to.
- A deployment-level block (`igaming.blockedCountries`) is never opened by a redirect.
- A consumer that keeps its own list of approved mirror domains binds `MIRROR_TARGET_POLICY`,
  and `upsertCountryRule` refuses an unapproved origin inside its transaction.

The admin views report `effectiveAccess` (`blocked | redirected | open`) next to the stored flags,
so a blacklisted country that is in fact open through a mirror is not shown as blocked.

## Consequences

- A consumer that turns redirection on without enforcing it on the primary domain lets the
  country in there too. The audit row makes that visible; it does not prevent it.
- Core stays free of origin routing and of any marker the web tier would have to protect.
- Confirmation (`confirm: true`) follows access rather than flags: opening a country or sending a
  blacklisted country to a different mirror needs it, closing access does not.
