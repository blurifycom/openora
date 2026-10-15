---
'@openora/core': minor
---

New `ON_RAMP_ADAPTER` and `ON_RAMP_WEBHOOK_VERIFIER` seam for buying crypto with fiat from a third-party vendor that delivers to the player's own deposit address. `GET /wallet/on-ramp/options`, `POST /wallet/on-ramp/quote` and `POST /wallet/on-ramp/checkout` gate on RG restriction, country access, the vendor's fiat range, deposit-enabled assets and the player's deposit limit before the vendor opens an order, re-quote on the server, and always deliver to a server-issued address. `POST /wallet/on-ramp/webhook` audits status updates for the address owner and never credits the ledger - the on-chain deposit does. Unbound, every route refuses.
