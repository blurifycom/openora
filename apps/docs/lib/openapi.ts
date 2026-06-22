import { createOpenAPI } from 'fumadocs-openapi/server';

// openapi.json is copied next to this app by tools/gen-docs-content.ts (from the
// repo-root docs/openapi.json emitted by `pnpm codegen`). Path is resolved from cwd.
export const openapi = createOpenAPI({
  input: ['./openapi.json'],
});
