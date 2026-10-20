---
'@openora/core': minor
---

Accepting an admin invitation now creates the account: `iam.invitations.accept` takes `{ token, name, password }` (breaking) and provisions the user, credential and invited role in one transaction. Invitation creation emits `iam.invitation.created`, and both invitation events land in the audit log under resource type `invitation`.
