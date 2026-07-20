# Ably realtime overlay

This optional overlay rebinds `REALTIME_TRANSPORT` and
`REALTIME_CLIENT_AUTHORIZER` after the chat plugin. To activate it, set both
`ABLY_API_KEY` and `ABLY_BROWSER_REALTIME_ENABLED=true` in the API server
environment. Requiring the second setting prevents an API key alone from
silently disabling SSE when the browser has not installed the Ably adapter.
When either setting is absent, the overlay does nothing and chat continues to
use first-party SSE.

The browser must use an Ably adapter only when its public realtime provider
setting is `ably`. The adapter obtains a grant from `chat.getConnection`, uses
the returned `tokenRequest`, subscribes to the granted channel, and enters or
leaves presence for that channel. It must never publish chat messages directly;
messages are sent through the Openora chat routes and persisted before the
server publishes them.

Ably grants are bound to the authenticated user id and permit only `subscribe`
and `presence` on the exact channels computed by the chat router. The API key
is never returned to the browser.

The server intentionally does not subscribe to Ably for the SSE route. Enable
this overlay only after the browser adapter is deployed and selected.
