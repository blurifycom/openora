---
'@openora/core': minor
---

The shared oxlint config (`@openora/core/oxlint/oxlintrc.json`) now enables `no-empty` as an error. It fails every empty block statement, not only an empty `catch`: `catch {}`, `if (x) {}`, `else {}`, `switch (x) {}` and a bare `{}` all error. A block holding only a comment, such as `catch { /* ignore */ }`, still passes, so the rule asks for a stated reason rather than forcing the error to be handled. Consumers extending this config fix or annotate those blocks on upgrade.
