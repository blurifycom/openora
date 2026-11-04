---
'@openora/core': minor
---

New admin permission resources that split asking for a sensitive action from approving it: `kyc-override-request` / `kyc-override-approval`, `bonus-grant-request` / `bonus-grant-approval` and `treasury-rebalance-request` / `treasury-rebalance-approval`. A request resource holds the single `request` action; an approval resource holds `view` (see the pending queue) and `approve`. They are separate resources because a role's matrix cell is a level, and a level always carries every action of its resource, so one resource could not give a role "request" without "approve".

The built-in `admin` role holds all six. Among the seeded roles, the Super Admin holds the three approvals and nobody else does. Requesting is granted to Customer Support Agent, Support Manager and Compliance Manager (KYC override), to Customer Support Agent, Support Manager and VIP Manager (bonus grant), and to Payments Manager and Finance / Accounting (treasury rebalance). Core enforces the pair in one place, and only when asked: with the new `kyc.requireApprovalForDirectOverride` platform config set to true, its own immediate `overrideKycStatus` and `bulkApproveKyc` also require `kyc-override-approval:approve`, so a role that may only request an override cannot apply one directly. It defaults to false, so nothing changes for an operator that does not set it. Every other action is gated by the overlay that owns it.

An existing database does not get these grants on upgrade. Role grants are reference data written by `seedRoles`, and no migration carries them, so move an action onto the new resources only after granting them: re-run `seedRoles`, or call `iam.setRolePermissions` for each role with its current grants plus the new ones. Custom roles get no grant either way.
