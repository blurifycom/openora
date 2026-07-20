# Ably realtime overlay

This optional overlay rebinds `REALTIME_TRANSPORT` and
`REALTIME_CLIENT_AUTHORIZER` after the chat plugin. Set `ABLY_API_KEY` only in
the API server environment. When it is absent, the overlay does nothing and
chat continues to use first-party SSE.

The browser must use an Ably adapter only when its public realtime provider
setting is `ably`. The adapter obtains a grant from `chat.getConnection`, uses
the returned `tokenRequest`, subscribes to the granted channel, and enters or
leaves presence for that channel. It must never publish chat messages directly;
messages are sent through the Openora chat routes and persisted before the
server publishes them.

Ably grants are bound to the authenticated user id and permit only `subscribe`
and `presence` on the exact channels computed by the chat router. The API key
is never returned to the browser.
