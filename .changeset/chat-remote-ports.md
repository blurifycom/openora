---
'@openora/core': minor
---

A service that does not load chat can now read chat's blocks and run chat's transfer check over the signed internal API, so it needs no chat module and no chat tables.

New `chat-remote` plugin (`@openora/core/engagement/plugins/chat-remote`). With `CHAT_SERVICE_URL` set (the chat service's private origin; `CHAT_SERVICE_NAME` names it, default `chat`) it binds `CHAT_BLOCK_READER` and `CHAT_TRANSFER_CHECK` to a client of the chat service, with a 500ms timeout and no cache. Unset, it binds nothing. In production the URL must be https unless `CHAT_SERVICE_ALLOW_HTTP=true`. Neither read is ever answered from a guess: a block read that cannot be answered throws a 503 `SERVICE_UNAVAILABLE`, and a transfer check that cannot be answered refuses the transfer as `chat_unavailable`.

The chat service serves the reads at `POST /internal/v1/chat/blocks/{excluded,blocked,blockers}` and `POST /internal/v1/chat-commands/transfer-check`, to the `SERVICE_NAME`s listed in `CHAT_BLOCK_READER_CALLERS` and `CHAT_TRANSFER_CHECK_CALLERS`. A caller not listed gets 403, and while a list is unset every caller is refused. The transfer check answers on a transaction of its own, so a remote caller does not hold the block locks the local binding holds until its transaction commits: a block committed after the answer and before the caller's money commits is not seen. Tip and transfer commands must move money through the new `guardChatTransfer(port, tx, input, commit)` from `@openora/core/contracts`: it checks, runs `commit` (the caller's debit and ledger rows on its transaction), checks again, and throws `ChatTransferRefusedError` on a refusal or a counterpart blocked since the first check, so the caller's transaction rolls back. That narrows the window to the time between the second answer and the commit; it never closes fully without a lock shared across the services.

The chat plugin now refuses to boot while `CHAT_SERVICE_URL` is set, so a process never binds the chat ports twice. Run chat-remote in a process that leaves chat out.

`player-management` no longer `dependsOn` chat. It requires the `CHAT_BLOCK_READER` port, which the chat module or `chat-remote` binds, so a split can leave chat out of a service that runs player-management. `social` and `chat-commands` still `dependsOn` chat.

A chat service on a database of its own now reads admin grants from the service that owns iam. That service serves `POST /internal/v1/iam/admin-permissions/{grants,super-admin}` to the `SERVICE_NAME`s in `ADMIN_PERMISSION_CALLERS` (unset refuses every caller), and the chat plugin binds `ADMIN_PERMISSION_RESOLVER` to a client of it when `IDENTITY_SERVICE_URL` is set. Nothing is cached on the chat side, and a failed call refuses the request. The chat plugin now `dependsOn` iam so its binding is the later one. `AdminGuard` reads the player id on a denial through `ACCOUNT_READER` when it is bound, so a service without a `player` table no longer logs a failed lookup.

Chat on a database of its own no longer asks the database-backed `PLAY_ELIGIBILITY` whether to withhold a room invite, since that port reads tables its database does not hold. With `IDENTITY_SERVICE_URL` set it relies on the fresh `excluded` flag of the account read, which mirrors `checkPlay`, and a failed read refuses the invite. `AccountReadOptions` gains `playEligibility` (also `accounts.input.playEligibility` on `POST /internal/v1/identity/accounts`): a `getAccounts` read that sets it also folds a `PLAY_ELIGIBILITY` an overlay rebinds into `excluded`, asking the bound port for each player account core's own check admits (resolved at call time, at most 8 accounts at once), so a stricter rule on the identity service reaches split-chat invites. It implies `fresh`, and only the invite checks set it: every other read, searches and username lookups included, keeps core's own `excluded` and never calls the port, so a port that throws cannot fail them. A custom `AccountReader` binding must honour the option.

**Breaking:** the chat plugin now `dependsOn` iam, so a plugin list that loads chat without iam no longer boots. Add iam to the list (with `iam:no-routes` in a `SERVICE_MANIFEST` for a chat service on its own database).

**Action required** for a chat service on a database of its own: set `ADMIN_PERMISSION_CALLERS` on the service that serves iam to include the chat service's `SERVICE_NAME`, and serve iam from the same service as identity (the one `IDENTITY_SERVICE_URL` points at). Without it every admin check on chat is refused.

The chat account closed and reopened jobs run on separate queues and retry, so they can arrive out of order. Each now reads the account fresh through `ACCOUNT_READER` and acts on its state now: a close applies only to an account that is missing, inactive or has the status closed, a reopen only to an active one that does not, so a closed account moved to suspended gets its rooms back. Each job reads the account before its transaction, so the read (an HTTP call on a split service) holds no connection or lock, then writes under a lock on the user, so a close and a reopen of one account never interleave. It reads again after commit and, when the account changed in between, applies the other job's writes, so the last job to write ends on the account's state now. A failed read retries the job.

`Account.player` gains `accountClosed`, true only for the status closed (`closed` stays true for suspended or closed, as social reads it). It is optional on the wire so a reply from an older identity service still parses; chat then reads `closed` in its place. An `AccountReader` an overlay binds should set it.

`GET /chat-command/mention-search` is now limited to 30 searches per 10 seconds per user (429 beyond that), since a typed query reads usernames across all players. The counter lives under the new `RATE_LIMIT_KEYS.CHAT_MENTION_SEARCH` (`'chat-mention-search'`, from `@openora/core/contracts`): an overlay that serves its own mention route limits it under the same key to share the count.

A manifest that names `chat-remote` with `CHAT_SERVICE_URL` unset now fails the boot with "set CHAT_SERVICE_URL".

New exports: `playerIdsOf` and `PlayerIdsLogger` from `@openora/core/contracts`, `ADMIN_PERMISSION_ROUTES`, `AdminPermissionWire`, `CHAT_BLOCK_READER_ROUTES`, `ChatBlockReaderWire`, `CHAT_TRANSFER_CHECK_ROUTES`, `ChatTransferCheckWire`, `guardChatTransfer`, `ChatTransferRefusedError`, `AllowedChatTransfer` from `@openora/core/contracts`, and `parseInternalCallers`, `internalProcedureFor` from `@openora/core/server`.

No migration.

Release order for a split deployment: ship identity and chat from the same release. An identity service older than this one drops the `playEligibility` flag, so a stricter play rule an operator binds would not withhold chat invites until both run this release.
