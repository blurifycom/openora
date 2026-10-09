import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { EMAIL_TEMPLATE_RENDERER, GEO_IP_ADAPTER } from '@openora/core/contracts';
import { DefaultEmailTemplateRenderer } from '@openora/core/mail';

export const WELCOME_BLOCKED_COUNTRY_IP = '203.0.113.66';

let heldAttempt: { reached: () => void; released: Promise<void> } | null = null;

/**
 * Parks the next delivery attempt of an eligible welcome mail and then fails it, so the
 * e2e can change the player's state between the queued job and its retry.
 */
export function holdNextEligibleWelcome() {
  let reached!: () => void;
  let release!: () => void;
  const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
  heldAttempt = { reached, released: new Promise<void>((resolve) => (release = resolve)) };
  return { reached: reachedPromise, release };
}

/**
 * Stands in for a consumer that puts a bonus in its welcome mail: the rendered text names the
 * eligibility core decided, so the e2e reads it off the captured mail. Every registration IP
 * the harness hands out (198.18.x.x) resolves to an allowed country.
 */
export default {
  id: 'test-welcome-promotions',
  dependsOn: ['mail', 'compliance'],
  register(ctx) {
    ctx.provide(GEO_IP_ADAPTER, () => ({
      lookup: async (ipAddress: string) => ({
        countryCode: ipAddress === WELCOME_BLOCKED_COUNTRY_IP ? 'DE' : 'PL',
      }),
    }));
    ctx.provide(EMAIL_TEMPLATE_RENDERER, () => {
      const fallback = new DefaultEmailTemplateRenderer();
      return {
        async render(template, locale, recipientName, antiPhishingCode) {
          const rendered = await fallback.render(template, locale, recipientName, antiPhishingCode);
          if (template.key !== 'welcome') {
            return rendered;
          }
          if (heldAttempt && template.data.promotionsEligible === true) {
            const held = heldAttempt;
            heldAttempt = null;
            held.reached();
            await held.released;
            throw new Error('held welcome delivery attempt');
          }
          const marker = `promotionsEligible=${template.data.promotionsEligible === true}`;
          return { ...rendered, text: `${rendered.text}\n${marker}` };
        },
      };
    });
  },
} satisfies Plugin<CoreTokenCatalog>;
