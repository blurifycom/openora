# Wallet module

Pointer file. It carries no rules, so it cannot drift from them. Open what the change needs:

- `docs/modules/wallet.md` - this module's surface and its own invariants. Start here.
- `docs/standards/money.md` - any balance change.
- `docs/standards/custody.md` - deposit addresses, sweep, reconciliation, asset catalog,
  custody vendor bindings.
- `docs/adapters/custody.md` - the custody port, topology, and sweep/reconciliation mechanics.
- `docs/adapters/payment.md` - the payment port and binding a synchronous PSP.
- `docs/standards/{audit,compliance}.md` - admin and withdrawal-gating paths.
