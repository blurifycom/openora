---
'@openora/core': minor
---

New admin permission resource `swap-config` (`view`, `update`) for the screen that sets a swap desk's pricing. Until now an overlay that owned swap pricing had to gate it on `wallet-asset`, so anyone allowed to edit the asset catalog could also change what players pay to swap. The built-in `admin` role and the seeded Finance / Accounting role are granted it; every other seeded role starts with no access.
