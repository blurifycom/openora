---
'@openora/core': minor
---

New admin permission resource `swap-config` (`view`, `update`) for the screen that sets a swap desk's pricing. Until now an overlay that owned swap pricing had to gate it on `wallet-asset`, so anyone allowed to edit the asset catalog could also change what players pay to swap. The built-in `admin` role and the seeded Finance / Accounting role are granted it; every other seeded role starts with no access.

An existing database does not get the Finance / Accounting grant on upgrade. Role grants are reference data written by `seedRoles`, and no migration carries them, so moving a swap pricing screen onto `swap-config` before granting it locks that team out. Grant it first, one of two ways:

- A Super Admin calls `iam.setRolePermissions` (`PUT /iam/roles/{roleId}/permissions`) for the role. It replaces the role's whole grant set, so send the current grants plus `swap-config`.
- Re-run `seedRoles`. It re-asserts the shipped matrix on every seeded role: a shipped grant whose level was changed goes back to the shipped level, and a shipped grant that was removed comes back. Grants on resources the shipped matrix leaves at no access are kept.

Custom roles get no grant either way; grant them `swap-config` before switching the screen over.
