// Generators live in @blurifycom/turbo-generators so the OSS monorepo and downstream
// consumer repos share ONE generator catalog + template set. `pnpm gen <type> ...`
// (and the MCP scaffold-* tools) all resolve through here.
// See packages/config/turbo-generators/src/config.ts.
export { default } from '@blurifycom/turbo-generators';
