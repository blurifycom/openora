---
root: false
targets:
  - '*'
description: Wallet - pointers to the money, custody, and payment-port docs. Read them before changing a balance, address, sweep, or vendor binding.
# Scoped to the wallet module and the ports a money change reaches through: the payment
# seam, and any overlay that binds a vendor.
globs:
  - 'packages/core/src/wallet/**'
  - 'packages/core/src/contracts/adapters/payment.ts'
  - 'extensions/**'
---

# Wallet

Routing only. Open the file you need; do not work from this list alone.

| Change                                                | Read                        |
| ----------------------------------------------------- | --------------------------- |
| Any balance change                                    | `docs/standards/money.md`   |
| This module's surface and its own invariants          | `docs/modules/wallet.md`    |
| Deposit address, sweep, reconciliation, custody rules | `docs/standards/custody.md` |
| Implementing or binding a custody vendor              | `docs/adapters/custody.md`  |
| Binding a synchronous PSP                             | `docs/adapters/payment.md`  |
