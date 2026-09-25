---
'@openora/core': minor
---

Adds `createMultiplexedEventStreamGenerator` to `@openora/core/server`, folding several
independent push-subscriptions (eg a set of per-user realtime channels) into one SSE-servable
async generator instead of one connection per channel. Each yielded event is tagged
`{ channel, payload }` with the channel name that produced it. A consumer opening several
per-user streams from the same client (balance, notifications, status updates, ...) can now serve
them over a single HTTP connection, which matters under HTTP/1.1's per-origin connection cap:
several permanently-open SSE streams otherwise starve ordinary API requests to the same origin
behind that cap. Every folded channel is subscribed for the generator's lifetime and torn down
together, same as `createEventStreamGenerator`, which this builds on and continues to export
unchanged.

Also re-exports each first-party module's per-user realtime channel-name function from its
public `server` entrypoint - `walletBalanceChannel` (`./wallet/server`), `kycStatusChannel`
(`./compliance/server`), `bonusBalanceChannel` (`./promo/server`), `notificationsChannel`
(`./engagement/server`), and `sessionEventsChannel` plus its `SessionEventsPush` push shape
(`./pam/server`). These functions already existed; they were only reachable from each module's
internal router file, which a consumer's own realtime route cannot import without a deep-import
boundary violation. Re-exporting them at the public entrypoint is what lets a consumer build a
route on `createMultiplexedEventStreamGenerator` that subscribes a user to several first-party
channels at once, without duplicating the channel-naming convention.
