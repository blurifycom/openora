---
'@openora/core': minor
---

The `rg.limit.set` event now carries `previousCurrency`, the replaced limit's own currency, so a limit changed across currencies can be shown with each amount in its own currency. It is null for a session limit, a first limit, or an event written before the field existed; the field is additive and defaults to null, so the event version stays at 5. The `rg.limit.admin_updated` notification gains an optional `previousCurrency` param.
