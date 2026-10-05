import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { EMAIL_TEMPLATE_RENDERER, GEO_IP_ADAPTER } from '@openora/core/contracts';
import { DefaultEmailTemplateRenderer } from '@openora/core/mail';

export const WELCOME_BLOCKED_COUNTRY_IP = '203.0.113.66';

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
          const marker = `promotionsEligible=${template.data.promotionsEligible === true}`;
          return { ...rendered, text: `${rendered.text}\n${marker}` };
        },
      };
    });
  },
} satisfies Plugin<CoreTokenCatalog>;
