import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  PlayerSchema,
  UpdatePlayerProfileInputSchema,
  DisplayCurrencyCodeSchema,
  DisplayCurrencyInputSchema,
} from '@openora/core/contracts';

// Player-facing self-profile contract. Caller resolved from the verified
// better-auth session; not admin-guarded. Auth-bound fields (email, password,
// avatar, 2FA) live on the identity contract.
export {
  UpdatePlayerProfileInputSchema,
  type UpdatePlayerProfileInput,
} from '@openora/core/contracts';

// The effective currency to render amounts in for the calling player, plus the
// operator's full supported list (for a currency picker). See
// ProfileService.resolveEffectiveDisplayCurrency for how `currency` is derived.
export const DisplayCurrencyInfoSchema = z.object({
  currency: DisplayCurrencyCodeSchema,
  supported: z.array(DisplayCurrencyCodeSchema),
});
export type DisplayCurrencyInfo = z.infer<typeof DisplayCurrencyInfoSchema>;

export const SetDisplayCurrencyInputSchema = z.object({
  currency: DisplayCurrencyInputSchema,
});
export type SetDisplayCurrencyInput = z.infer<typeof SetDisplayCurrencyInputSchema>;

export const profileContract = {
  get: oc.route({ method: 'GET', path: '/profile' }).output(PlayerSchema),

  update: oc
    .route({ method: 'PATCH', path: '/profile' })
    .input(UpdatePlayerProfileInputSchema)
    .output(PlayerSchema),

  // Display is presentation-only: picking a currency never touches a balance, a
  // ledger row, or a transaction amount. Self-service - always scoped to the
  // caller resolved from the session, never takes a userId input.
  getDisplayCurrency: oc
    .route({ method: 'GET', path: '/profile/display-currency' })
    .output(DisplayCurrencyInfoSchema),

  setDisplayCurrency: oc
    .route({ method: 'PUT', path: '/profile/display-currency' })
    .input(SetDisplayCurrencyInputSchema)
    .output(DisplayCurrencyInfoSchema),
};
