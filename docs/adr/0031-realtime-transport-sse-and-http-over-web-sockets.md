# ADR-0031: Realtime Transport - SSE and HTTP over WebSockets

**Date**: 2026-07-16
**Status**: Proposed

## Context

Client-facing push (live chat, live odds, big-win/jackpot feeds, PvP round state,
settlement notifications) flows through the `REALTIME_TRANSPORT` seam
(`packages/core/src/contracts/adapters/realtime.ts`), served today as SSE via oRPC
`eventIterator`/`useEventStream` (ADR-0007). It is deliberately separate from the
inter-module `MESSAGE_BROKER` (ADR-0010): realtime is server→client, best-effort,
ephemeral; the broker is server→server with delivery guarantees. ADR-0030 made
production distributed-only, so the in-process realtime default is now a test-only
double and `REALTIME_TRANSPORT` is unbound in production (lazy - it only throws if a
realtime route is actually exercised). We must decide the production transport, and
whether a future **sportsbook with betslips** (and possibly a **betting exchange**)
forces WebSockets instead of SSE + HTTP.

The forces:

- **The traffic is asymmetric.** A sportsbook is a high-rate server→client fan-out
  (odds, suspensions, event state, settlements - all push) plus a low-rate,
  transactional client→server command channel (place bet, accept price change,
  cash-out). None of the _streams_ are bidirectional; the only upstream traffic is
  discrete commands.
- **Bet placement is a transaction, not a stream.** Its ~1-1.5s latency budget is
  spent on server-side re-pricing, suspension checks, RG/geo/self-exclusion guards,
  and an atomic wallet debit - not on transport RTT. It must be idempotent,
  auditable (the append-only hash-chained `audit` module), and return one definitive
  accept/reject/new-price response. Regulation (explicit, server-enforced
  price-change acceptance; per-bet audit evidence; the server, not the client, is the
  price authority) argues _for_ request/response, not a duplex socket.
- **Reconnection matters.** A dropped connection must not miss a market suspension.
- **Multi-instance is a given.** A client's long-lived connection lands on one
  replica; an event may be published on another.
- **Infra goal is "only Redis"** (ADR-0028/0030): cache, rate-limiter, job queue, and
  the message broker (ADR-0030 + the Redis Streams broker) all run on Redis.
- **WebSockets have real but narrow strengths**: cheap high-frequency _client→server_
  messages on an already-open connection, and true full-duplex - which matter for an
  exchange order book or micro-betting, not for fixed-odds push + transactional bets.
- **The product roadmap needs no duplex channel.** Mapping the roadmap onto transport
  requirements: v1 chat/friends/lobby/balance is low-rate push; the v2 PvP games
  (a coin toss, a grid reveal, a dice roll) are turn-based - a command every few seconds, HTTP RTT invisible
  next to animation time; pooled gambling (streamer + audience) is a large fan-out of
  shared state (pot, countdown, result) plus bursty _money_ commands that specifically
  want HTTP idempotency + audit, not WS frames; the sportsbook adapter is odds push to
  the client (a vendor's WS SDK stays a server-side adapter concern). A betting
  exchange / micro-betting - the only genuinely duplex cases - are not on the roadmap.
- **The clients are mobile PWAs.** WebTransport/HTTP-3 (QUIC) is rejected on maturity,
  not taste: Node has no production-grade WebTransport server, and mobile carriers /
  corporate proxies still drop UDP - so it would require a permanent WS fallback,
  i.e. two stacks to maintain.

Alternatives on the table: (a) SSE push + HTTP commands; (b) WebSockets by default;
(c) a managed realtime vendor (Ably/GetStream/PubNub) from the start;
(d) WebTransport over HTTP/3.

## Decision

We keep **SSE for the server→client push stream and HTTP request/response (oRPC) for
all client commands**, both behind the existing seams (`REALTIME_TRANSPORT` for push,
oRPC routes for commands). Cross-instance fan-out is done with **Redis Pub/Sub**: a
`RedisPubSubRealtimeTransport` that auto-binds on `REDIS_URL` (Pub/Sub, not Streams -
realtime needs no per-consumer durability, acks, or unbounded retention, unlike the
Redis Streams `MESSAGE_BROKER`). Every replica subscribes; a publish goes to Redis and
each replica pushes to its locally-connected clients. `SseClientAuthorizer` (the
first-party SSE connection grant) returns to production as its companion.

We do **not** adopt WebSockets now. We reject the alternatives:

- **WebSockets by default** - lost because for fixed-odds push + transactional bets it
  adds complexity with no payoff: it does not lower single-message push latency (both
  keep a TCP connection open), it has no built-in reconnect/resume (SSE gets
  `EventSource` auto-reconnect + `Last-Event-ID` replay for free, so a blip cannot miss
  a suspension), it does not help the multi-instance problem (that needs the same Redis
  Pub/Sub bus regardless), and it weakens the money path (idempotency, exactly-once,
  and 1:1 audit are native to request/response and must be hand-built over WS frames).
- **A managed vendor from the start** - lost on added cost and an external dependency
  for a capability Redis + SSE already deliver; it stays available as a later overlay
  if global edge latency (sub-100ms worldwide) ever demands PoPs we won't self-host.
- **WebTransport over HTTP/3** - lost on maturity: no production-grade Node server,
  UDP blocked on enough mobile/corporate networks that a WS fallback (a second stack)
  becomes permanent. It remains the natural successor _if_ a duplex channel is ever
  built and the ecosystem catches up.

The long-lived commitment is the **seam**, not the wire protocol: `REALTIME_TRANSPORT`
plus `useEventStream` isolate every domain and every client screen from the transport.
If the roadmap later adds an exchange, the cost is one adapter on one channel - versus
hand-building reconnect/resume, upgrade auth, LB config, and audit patterns for 100% of
traffic today to serve a feature that is 0% of the roadmap.

Four implementation decisions lock in the long-term shape of the SSE driver:

1. **One multiplexed SSE connection per client** - topics are multiplexed inside a
   single event stream, never one `EventSource` per feature (HTTP/1.1's 6-connection
   limit makes per-feature streams a dead end).
2. **HTTP/2 required at the edge** (ALB/CloudFront terminate it) - removes the same
   connection limit end-to-end.
3. **`Last-Event-ID` resume from day one** - the driver assigns each event a monotonic
   id and replays what the client missed on reconnect, so a network blip cannot miss a
   market suspension or round result. Because Pub/Sub is fire-and-forget and a
   reconnecting client can land on any replica, resume needs a **shared, bounded
   per-topic replay buffer** (a capped Redis list/stream per topic, trimmed by count or
   age - seconds, not durability), which every replica reads on reconnect before
   attaching the client to the live subscription. Resume is therefore best-effort by
   design: a disconnect longer than the retention window returns a directive telling
   the client to resync current state over HTTP rather than silently replaying a
   partial history. Sizing the window is a driver-spec decision, not an ADR one.
4. **Presence via Redis** (SET + heartbeat TTL) when a feature needs it - pooled
   gambling's "N watching" - never per-instance memory.

WebSockets (or **WebTransport over HTTP/3**, the more modern low-latency duplex option)
remain a **seam-swappable adapter** for the narrow cases that genuinely justify them:
a **betting exchange** order-entry stream (rapid client→server order place/cancel/amend),
**micro-/next-play betting**, or adapting an upstream odds vendor that ships a WS SDK
(an `ODDS_FEED`-style adapter concern that never leaks to our clients). When such a
feature is built, its module binds a WS transport for _that_ channel only, with zero
change to the betting domain or the rest of the platform.

## Consequences

**Positive:**

- Simplest transport that fully covers chat, odds, feeds, settlements, and a fixed-odds
  sportsbook - "not a compromise" per the igaming-domain review.
- Robust reconnection with no client code: the browser reconnects and re-sends
  `Last-Event-ID` on its own, so a network blip cannot silently miss a market
  suspension - the platform only has to keep the short replay buffer behind it.
- Standard HTTP everywhere for commands: gateway auth, rate-limiting, WAF, idempotency
  keys, and a clean request/response that maps 1:1 to an `audit` entry - the money and
  regulatory path stays transactional and evidentiary.
- Keeps the "only Redis" infra story: realtime fan-out reuses the same Redis, no new
  broker.
- The seam keeps WebSockets/WebTransport a per-channel adapter swap, not a rewrite.

**Negative / trade-offs:**

- SSE is unidirectional; a genuinely high-frequency client→server stream (exchange
  order flow, micro-betting) is not served and will require a WS/WebTransport adapter
  later - explicitly deferred, not designed out.
- `Last-Event-ID` resume is not free with Pub/Sub: the driver must maintain a bounded
  shared replay buffer per topic and clients must handle a "resync over HTTP"
  directive when a disconnect outlives the retention window. That path needs a test -
  it is the one place a client can silently diverge from server state.
- `RealtimePresence` ("N online") needs a shared store (Redis SET + heartbeat/TTL) to
  work across instances; the base Pub/Sub driver ships without it (the port keeps
  presence optional) until a feature needs it.
- Delivery latency is bounded by geography and internal hops (publish → Redis →
  replica → client), not the transport; genuine sub-100ms-global push would need edge
  PoPs (a managed vendor), which the transport choice does not by itself provide.

**Neutral:**

- Realtime stays lazy/unbound in production until `RedisPubSubRealtimeTransport` +
  `SseClientAuthorizer` land; only deployments using a realtime feature are affected.
- Relates to ADR-0007 (realtime seam / SSE), ADR-0010 (realtime kept separate from the
  broker), ADR-0030 (distributed-only seams), ADR-0028 (Redis reference adapters). The
  `REALTIME_TRANSPORT` row in `messaging-and-microservices` (durable driver) updates to
  "Redis Pub/Sub (`REDIS_URL`)" when the driver is implemented.
