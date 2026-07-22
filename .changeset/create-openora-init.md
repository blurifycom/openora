---
'@openora/core': minor
'@openora/create': minor
---

Add `@openora/create`, a zero-dependency npm initializer (`npm create @openora my-casino`) that
scaffolds a headless Openora consumer app straight from the published `@openora/*` packages - no
sibling OSS checkout required.

The shared consumer template (`tools/templates/consumer/`) now resolves its plugin registry via
the new `corePlugins()` export from `@openora/core/server`, and takes `coreVersion`, `mcpCommand`,
and `mcpArgsJson` as template variables so the same template tree serves both the linked-dev
scaffolder (`pnpm create:app`) and the new npm-mode initializer without forking.
