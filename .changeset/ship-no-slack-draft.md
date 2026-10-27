---
'@openora/create': patch
---

Consumer `ship` no longer drafts a Slack notice after opening the MR. The forge integration announces new MRs, so the draft only duplicated it.
