/**
 * Compile-time proof that sealed compliance tokens cannot be provided.
 *
 * `RG_SELF_EXCLUSION_SERVICE` is a `SealedToken<unknown>` from
 * `@oss/compliance-invariants`. `ModuleRegistry.provide()` accepts only
 * `Token<T>`. The two are structurally incompatible, so the call below fails
 * type-checking. The `@ts-expect-error` directive consumes that error - if the
 * seal regresses (the call becomes assignable), TS reports the directive as
 * unused and the build fails. Either way you find out before runtime.
 *
 * Not exported, not registered anywhere. Only purpose is to make the seal
 * regression visible in CI.
 */

import { definePlugin, type ModuleRegistry } from '@oss/plugin-host';
import { RG_SELF_EXCLUSION_SERVICE } from '@oss/compliance-invariants';

export const sealedFailDemo = definePlugin({
  id: 'example-vip-tier.sealed-fail-demo',
  register(ctx: ModuleRegistry) {
    // @ts-expect-error - sealed tokens cannot be provided; this line must not typecheck
    ctx.provide(RG_SELF_EXCLUSION_SERVICE, () => ({}));
  },
});
