---
'@openora/core': patch
---

Saving a payout destination now checks the address against the format for its network before it is whitelisted with the custody provider - a malformed paste like `abcdefgh` can no longer be saved to a player's address book or named as a withdrawal's `destinationAddress`. The check is a per-chain regex (SEGWIT, BITCOIN_CASH, LITECOIN, DOGECOIN, XRP_LEDGER, ERC20, BEP20, TRC20, SOLANA); a network with no entry falls back to the existing length bound so an operator-added chain is never blocked by a table core has never heard of. The new predicate, `isWalletAddressValidForNetwork`, is exported from `@openora/core/wallet/contract`. This only catches an obviously malformed address - the payment provider is still the only thing that can tell a live address from a well-formed dead one.

Fixed a race in the withdrawal address book's 50-address-per-player cap: concurrent saves could each read the count before any of them wrote, letting more than 50 rows land for one player. The count and the insert now run inside one transaction, serialized per player by a transaction-scoped advisory lock, so the cap holds under concurrent writers. A rejected save now correctly distinguishes "the cap is full" from "this exact address is already saved".
