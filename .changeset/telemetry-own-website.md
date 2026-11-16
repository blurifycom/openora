---
'@openora/core': patch
'@openora/create': patch
---

Install telemetry (boot, heartbeat, scaffold) now goes to its own Umami website instead of the public demo's, so demo traffic stats no longer count installs as visitors. Same collector URL, same payload, same opt-outs.
