// Generators live in @blurifycom/core/turbo-generators so the OSS monorepo and
// downstream consumer repos share ONE generator catalog + template set. `pnpm gen
// <type> ...` (and the MCP scaffold-* tools) all resolve through here.
// See packages/core/turbo-generators/src/config.ts.
export { default } from '@blurifycom/core/turbo-generators';
