import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  PlayerSchema,
  UpdatePlayerProfileInputSchema,
  DisplayCurrencyCodeSchema,
  DisplayCurrencyInputSchema,
  DisplayDecimalPlacesSchema,
} from '@openora/core/contracts';

// Player-facing self-profile contract. Caller resolved from the verified
// better-auth session; not admin-guarded. Auth-bound fields (email, password,
// avatar, 2FA) live on the identity contract.
export {
  UpdatePlayerProfileInputSchema,
  type UpdatePlayerProfileInput,
} from '@openora/core/contracts';

export const DisplayCurrencyInfoSchema = z.object({
  currency: DisplayCurrencyCodeSchema,
  supported: z.array(DisplayCurrencyCodeSchema),
  decimalPlaces: DisplayDecimalPlacesSchema,
});
export type DisplayCurrencyInfo = z.infer<typeof DisplayCurrencyInfoSchema>;

export const SetDisplayCurrencyInputSchema = z.object({
  currency: DisplayCurrencyInputSchema,
});
export type SetDisplayCurrencyInput = z.infer<typeof SetDisplayCurrencyInputSchema>;

export const SetDisplayDecimalPlacesInputSchema = z.object({
  decimalPlaces: DisplayDecimalPlacesSchema,
});
export type SetDisplayDecimalPlacesInput = z.infer<typeof SetDisplayDecimalPlacesInputSchema>;

export const profileContract = {
  get: oc.route({ method: 'GET', path: '/profile' }).output(PlayerSchema),

  update: oc
    .route({ method: 'PATCH', path: '/profile' })
    .input(UpdatePlayerProfileInputSchema)
    .output(PlayerSchema),

  getDisplayCurrency: oc
    .route({ method: 'GET', path: '/profile/display-currency' })
    .output(DisplayCurrencyInfoSchema),

  setDisplayCurrency: oc
    .route({ method: 'PUT', path: '/profile/display-currency' })
    .input(SetDisplayCurrencyInputSchema)
    .output(DisplayCurrencyInfoSchema),

  setDisplayDecimalPlaces: oc
    .route({ method: 'PUT', path: '/profile/display-decimal-places' })
    .input(SetDisplayDecimalPlacesInputSchema)
    .output(DisplayCurrencyInfoSchema),
};
