# ADR-0007: First-party chat over an own realtime transport, with a ChatTransportPort seam

**Date**: 2026-05-21 (accepted 2026-05-29)
**Status**: Accepted. The `ChatTransportPort` is realized as the generic `REALTIME_TRANSPORT` seam (`@oss/adapters` `realtime.ts`), with a first-party in-process default and the `chat` module streaming live over SSE - see ADR-0014. Economy commands (`/tip`/`/rain`/`/gift`) remain open.

## Context

The reference consumer (Consumer) needs a live community chat with money-moving commands: `/tip` (player-to-player transfer), `/gift` (a claimable drop one player wins), and `/rain` (a balance split across many online players). Received gift/rain funds carry a wagering/rollover requirement before withdrawal.

Two options were weighed: integrate a managed live-chat SaaS (Stream, Sendbird, PubNub) behind an adapter, or build chat as a first-party module.

Key facts:

- `/tip`, `/rain`, `/gift` are **not chat features** - they are wallet operations (internal transfer + rollover tagging + a provably-fair winner draw for gifts). No chat vendor moves real money or enforces wagering for us; that logic must live in our domain regardless of the chat backend.
- The platform needs its **own realtime transport anyway** for PvP games: server-synced countdown, live bet feed, presence ("Online: 10,400"), and round state. OSS currently has no WebSocket/SSE layer. Once that exists for games, carrying chat messages over it is near-zero marginal cost.
- Managed live-chat is priced per MAU / concurrent connection. At 10k+ concurrent it is expensive, and we would still be paying for transport we already build for games. Some vendors do allow custom commands/events, so extensibility exists - but the economy logic still stays with us.

## Decision

1. **Chat is a first-party OSS module** (the existing `chat` module: global + room messages + soft moderation), running on the platform's own realtime transport (a shared `platform` primitive also used by gaming for live round state).
2. **Economy commands (`/tip`, `/rain`, `/gift`) are first-party domain logic** - implemented against the `wallet` (internal transfer) and `bonus` (rollover) modules, with a provably-fair draw for gift winners. They are never delegated to a chat vendor.
3. **Expose a `ChatTransportPort` seam** so an operator can swap message transport / presence / moderation to a managed service if they choose, without touching the economy logic. Same provider/adapter philosophy as the UI provider (ADR-0003) and the vendor ports (ADR-0002).

The realtime transport itself is a separate, shared concern (a future ADR / `platform` package) because gaming needs it independently of chat.

## Consequences

**Positive:**

- No per-MAU SaaS bill by default; full control over the `/tip` `/rain` `/gift` mechanics and their rollover/fairness rules.
- Reuses the realtime layer built for PvP games - chat is incremental, not a second infrastructure.
- Operators keep a swap point (`ChatTransportPort`) if they want managed transport at scale.
- Money logic stays in `wallet` + `bonus` where it is auditable and testable, not split across a third party.

**Negative / trade-offs:**

- We own moderation, abuse handling, and scaling of the chat transport - real work a SaaS would otherwise absorb.
- A first-party realtime layer must be built and operated (load, reconnection, fan-out). This is on the critical path regardless because of games.

**Neutral:**

- `ChatTransportPort` covers message send/receive, presence, and moderation hooks - the common denominator. Vendor-specific extras sit behind optional capability flags, not in the base port.
- The economy commands live in the chat module's surface but call `wallet`/`bonus` via events/contracts, respecting the no-cross-module-import rule.
