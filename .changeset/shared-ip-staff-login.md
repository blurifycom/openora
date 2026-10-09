---
'@openora/core': patch
---

A staff login no longer tags the players who share its IP as `multi_account` and `bonus_abuser`: `getPlayerUserIdsSharingLoginIp` returns no one when the logging-in user is not a player.
