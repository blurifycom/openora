# Support-Chat Adapter

The seam to a vendor that runs the player's live-support chat widget. Core decides which vendor
customer a player is and what support staff see about them; the vendor's HTTP calls, field
definitions and widget stay in the adapter. Core never learns a vendor's name.

Contract: [`packages/core/src/contracts/adapters/support-chat.ts`](../../packages/core/src/contracts/adapters/support-chat.ts).
Read it for the exact method names and shapes. This file covers what the port is for and how a
binding has to behave.

## What core sends, and what it never sends

The backend, not the browser, tells the vendor who the chat customer is, so a player cannot pose
as another player to support staff, and one player is one vendor customer on every device. The
session route takes no input: it always answers for the caller's own player.

Next to the chat, support staff see a context core writes server-to-server, so the player cannot
edit it: the player and user ids, username and email, the account status, whether a
self-exclusion or a cooling-off is in force, the KYC status, the rank name and the active wallet
currency, plus when it was read. The account status shows an active self-exclusion as
self-excluded, except that a suspended or closed account keeps its own status; the self-exclusion
flag is set whenever one is active either way. Responsible gambling is read the way compliance
reads it: a self-exclusion binds until it is lifted, even past its end date; a cooling-off ends at
its expiry, even before the sweep marks it expired.

Core never sends a balance, a document, a phone number or a date of birth. The context schema is
strict, so a field reaches the vendor only when it is added to the contract on purpose.

## What a binding must guarantee

- **One vendor customer per customer id.** Asked for a token without a customer id, create a new
  customer and answer its id. Asked with one, answer a token for exactly that customer. Never
  answer with another customer: core refuses such a token as unavailable rather than open a chat
  as someone else.
- **Answer the token in the port's shape.** Core validates it; a missing access token, a
  non-positive lifetime or anything else malformed answers the player as unavailable.
- **Throw the port's provider error on a refusal, an unreachable vendor or an unexpected
  answer,** with a short reason. The reason goes to the log only; the player gets a fixed
  "unavailable" refusal. Never put a token, a request body or an unmasked email in it, and do
  not attach a raw HTTP error as its `cause`: it can carry headers and bodies. Any other error
  that escapes the adapter is handled the same way, but core keeps only its class name as the
  reason, so throwing the provider error is what leaves a useful reason in the log.
- **Make the context sync idempotent.** The same context may be written more than once, and two
  syncs for one player may run at once. Core re-reads the context after each write and writes
  again when it moved, so the last write converges on the database's latest state; the adapter
  only has to write what it is given.
- **Own the vendor mapping.** Which vendor fields hold the context, their types and definitions,
  and the customer's display name and email are the adapter's. Mask the email in any log line.
- **Keep operator-owned fields in the adapter.** A field only one operator has, such as its own VIP
  flag or a back-office profile link, is added by that operator's adapter, not by core.

## Flow

1. The player opens the chat. Core throttles the call per player, because every call spends the
   operator's vendor quota.
2. A player already linked gets a token for their customer. A player opening the chat for the
   first time gets a new vendor customer, linked to them in the same transaction as its audit
   entry. When two first opens race, the first link wins and every caller gets its customer; the
   loser's vendor customer is left unused. A vendor customer already linked to another player
   fails the open instead of merging two players.
3. Core enqueues a context sync and answers the token at once; vendor writes never sit on the
   request path. On a first open the sync rides on an event committed with the link, so a job
   queue outage delays the first context instead of losing it.
4. The sync job writes the context for a linked player. It retries with backoff for about four
   hours, then logs an error and tries once at the top of each hour until a sync lands, so an
   outage does not leave support staff on a stale RG state. Each give-up reaches the bound
   error tracker with the player's user id and the last error. Every give-up for a player in the
   same hour shares one hourly try. Scheduling that try is itself retried once; when the job
   queue refuses it twice, or the process stops before it is scheduled, an error names the
   player and their context waits for their next refresh.
5. Besides every chat open, a linked player's context is refreshed when a self-exclusion starts
   or is lifted, when a cooling-off starts, ends or is lifted, when the account status changes or
   the account is closed or reopened, when the KYC status or rank changes, and when the email
   changes. A player who never opened the chat gets no sync. A username change has no event today,
   so it reaches the vendor on the player's next chat open; the same holds for an active-currency
   change.

## Unbound

Core binds no provider and no history reader. Without a provider, the session route answers
service-unavailable as not configured and boot logs one warning; without a reader, the history
route does the same with its own warning. Whether a player is linked is read from the database, not
from the process, so a refresh still enqueues a sync for a player another process linked. A
process without a provider fails that job, logging a warning per attempt, and the queue retries
it, so in a fleet where only some processes have the provider bound the sync lands on one that
has it instead of being dropped. A give-up still schedules the hourly try, whichever process
gives up. With no provider anywhere and no linked player, nothing is enqueued and nothing fails.

To turn the support chat off, remove the module from `extensions.config.ts`, together with any
plugin that depends on it. Keeping the module loaded with no provider bound while players are
still linked is treated as a misconfiguration: each refreshed player keeps getting one try an
hour, and every failed one logs an error, until a provider is bound or the module is removed.

## Support history

A second port, `SUPPORT_HISTORY_READER`
([`packages/core/src/contracts/adapters/support-history.ts`](../../packages/core/src/contracts/adapters/support-history.ts)),
lets the back office list a player's vendor tickets and chat threads through the player-history
route (the catalog and the contract name it). It is a separate token from the chat provider: an
operator may bind either without the other. Only an admin holding the support-chat view
permission reaches it. No predefined role carries that grant except the super admin; an operator
gives it through a role it assigns, which needs the iam module loaded. Without iam, the static
fallback roles decide, and none of them grants it.

Core works out which identities belong to the player and hands them to the reader:

- **Tickets** are matched by the requester's email, inside email windows. Each window is one
  email the player held, from when it became theirs (registration or an email change) to when it
  stopped being theirs; the current email's window is open-ended. Previous emails come from the
  audit log's email-change rows, and only the three most recent are kept. A freed address can be
  registered by another player, so a ticket counts only when it was created inside its email's
  window: the reader must filter by creation date, never return every ticket an address ever
  opened.
- **The email trail is trusted from its end back to its first break.** The audit rows are written
  shortly after each change, outside the change's transaction, so one can be lost, duplicated, land
  out of order or carry a skewed time. Each row carries the time stamped right after the change, so
  a slow write does not move a window's bounds; a row written before that field existed is timed by
  when it was written. A redelivered event writes its row again: a row that repeats any earlier one,
  change time included, counts once, but a repeated row without a change time cannot be told from a
  real repeat and breaks the trail. Core walks back from the current email: the last change must
  name the current email as its new one, each change must name as its new email the one the next
  change replaced, and each change's time must be later than every earlier change and registration,
  and no more than 5 seconds later than its own audit row was written (a change always comes before
  its write; the margin allows for clocks that disagree). At the first break walking back it stops:
  the windows after the break are kept, everything from the break back is dropped, the window opened
  by a change with a wrong time included, and a warning naming the user goes to the log. When even
  the last change cannot be trusted, there is no window at all: the tickets section is reported
  unavailable and the reader is not asked. The rows are append-only and nothing repairs them; the
  player's next email change heals that state, unless an earlier row claims a time ahead of the real
  clock: every later change then reads as falling back, and the section stays unavailable until real
  time passes that stamp, which with realistic clock skew takes seconds. Core fails closed rather
  than trust it.
- **Another account's changes bound the oldest window.** Nothing records the email an account
  registered with, so a lost first change would leave the next email taken as held from
  registration, over the time another account held it. When the trail is intact and its oldest
  window starts at registration, core looks for another account's email change naming that
  address, compared case-insensitively, after registration and before the window closes. The
  latest one decides: another account leaving the address opens the window then, and another
  account taking it drops the window, since nothing places when that account let it go. Either
  way the trail counts as broken: the tickets section is not complete, the warning goes to the
  log, and when no window is left the section is unavailable.
- **What the trail cannot notice.** A lost first change stays unseen only when the other account's
  change of that address was lost too, or the address was freed another way, such as the account
  being deleted. A lost run of changes returning to the address it left (A to B recorded, B to C and
  C to B lost, B to D recorded) also leaves a trail that looks consistent, so B's window spans the
  gap. A change time later than the real change by no more than its audit write's own delay plus the
  5-second margin also goes unseen: a fast clock with a delayed or redelivered write, or a legacy
  row timed by its write. It widens the earlier email's window by that much. A clock running behind
  goes unseen for as long as each time it stamps is still later than every earlier one, shifting the
  bounds by the lag. The lost rows follow from the email-change event being emitted best-effort
  rather than through the outbox; moving that emit to the outbox is the fix, and is not part of this
  port.
- **Chats** are matched by the vendor customer the player is linked to. A player who never
  opened the chat has no link, and the reader is not asked.

What a reader must guarantee:

- **A request that leaves resolved items out must not touch the vendor's resolved archive.**
  Resolved tickets cost their own calls; the back office asks for them only when staff opt in.
- **One item per chat thread.** The vendor's agent app links each thread on its own, so the item
  id is the thread id.
- **Statuses per kind.** A ticket carries one of the five ticket states the contract lists, and a
  chat one of its two. Core validates every item against the strict item schema and those
  per-kind states; one item off-contract makes that whole section unavailable.
- **UTC timestamps ending in `Z`.** The schema accepts nothing else, such as an offset.
- **Absolute https links.** An item's link opens in the back office, so the schema accepts only a
  URL starting `https://`: an http, `javascript:` or `data:` link, or a slash-less `https:` form
  a browser would resolve against the back office's own origin, makes the section unavailable.
- **Errors follow the chat provider's rules.** Throw the port's support-history provider error
  with a short reason: no token, no request body, emails masked. Any other error that escapes is
  reduced to its class name.

The answer has a tickets and a chats section. Each one either carries its items, most recently
updated first, or says it is unavailable: its read failed, or the current email could not be
trusted. The tickets section also says whether it is complete: true only when every email the
player held was searched, false when a break in the trail or the cap of three previous emails
left older ones out, so staff know an older ticket may exist that the list does not show.
The tickets section also says there is no email to match when the account has neither an email
nor an email change, and the chats section says the player is not linked when there was nothing
to ask. One section failing never hides the other; the reason goes to the log only. Core caches
the whole answer for 60 seconds per player and per resolved setting, keeping its original fetch
time, and limits each admin to 30 calls a minute, cache hits included, so staff clicking around do not
spend the vendor's API quota. The default cache is in-process, so each replica fetches on its
own; binding the Redis cache shares it.

## Binding a vendor

An overlay plugin in the consumer's repo binds the provider, the history reader, or both.
Scaffold it with `/scaffold-plugin` and register it after the support-chat module.

## Not built yet

An account-manager field in the context, erasing the vendor customer and its history under a
data-rights request, and pushing history updates instead of the cache wait for those features to
land in core.
