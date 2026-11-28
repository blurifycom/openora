import * as z from 'zod';

export const WAGER_PRODUCTS = ['casino', 'live-casino', 'sportsbook', 'pvp'] as const;
export const WagerProductSchema = z.enum(WAGER_PRODUCTS);
export type WagerProduct = z.infer<typeof WagerProductSchema>;

export const isWagerProduct = (value: string): value is WagerProduct =>
  (WAGER_PRODUCTS as readonly string[]).includes(value);

export const wagerProductProviderPrefix = (product: WagerProduct): string => `${product}:`;

export function wagerProductOfProviderName(providerName: string | null): WagerProduct | null {
  const separator = providerName?.indexOf(':') ?? -1;
  if (!providerName || separator <= 0) {
    return null;
  }
  const product = providerName.slice(0, separator);
  return isWagerProduct(product) ? product : null;
}

export type WagerContext = {
  provider: string;
  providerGameKey?: string;
  product: WagerProduct;
  gameId?: string;
  categorySlug?: string;
  rtp?: string;
};

const RTP_PATTERN = /^(0(\.\d{1,18})?|1(\.0{1,18})?)$/;

export const isWagerRtp = (rtp: string) => RTP_PATTERN.test(rtp);

export const isUsableRtp = (rtp?: string | null): rtp is string =>
  rtp !== undefined && rtp !== null && isWagerRtp(rtp) && /[1-9]/.test(rtp);
