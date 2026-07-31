---
root: false
targets:
  - '*'
globs:
  - 'packages/**/schema/**'
  - 'packages/**/service/**'
  - 'packages/**/adapters/**'
  - 'packages/core/src/**/admin-*.ts'
  - 'packages/**/seed/**'
  - 'packages/**/drizzle/**'
  - 'packages/**/drizzle.config.ts'
  - 'packages/**/migrate.ts'
  - 'packages/core/src/server/db/**'
  - 'packages/testing/src/**'
  - 'tools/db/**'
description: SQL / Drizzle routing rule - read the database standard before editing matching files.
---

# Database conventions

For every matching file, read [`docs/standards/database.md`](../../docs/standards/database.md) in full before editing.

That file is the sole authoritative database and Drizzle standard. Do not duplicate its rules here.
