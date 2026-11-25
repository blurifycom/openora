import { createInternalClient, parseServiceManifest } from '@openora/core/server';
import type { CoreTokenCatalog, InternalClient, Plugin } from '@openora/core/server';
import {
  ADMIN_GAME_REPORTING,
  ADMIN_WALLET_REPORTING,
  EXCHANGE_RATE_READER,
  MONEY_REPORTING,
  PLAYER_RANK_READER,
  PLAY_ELIGIBILITY_PROJECTION,
  RG_LIMIT_LEDGER,
  WALLET_READER,
  type AdminGameReporting,
  type AdminWalletReporting,
  type ExchangeRateReader,
  type MoneyReportingPort,
  type PlayerRankReader,
  type PlayEligibilityProjectionPort,
  type RgLimitLedgerPort,
  type WalletReader,
} from '@openora/core/contracts';
import { remoteMoneyPort } from './service/remote-money-port.service.js';

// A money call slower than this fails closed.
const MONEY_CALL_TIMEOUT_MS = 2_000;

/**
 * A platform service that does not load the money modules reaches them through the money
 * service: set `MONEY_SERVICE_URL`. Unset, nothing is bound.
 */
function moneyClient(): InternalClient | null {
  const url = process.env['MONEY_SERVICE_URL'];
  if (!url) {
    if (
      parseServiceManifest(process.env['SERVICE_MANIFEST'])?.some((m) => m.id === 'money-remote')
    ) {
      throw new Error(
        'SERVICE_MANIFEST names money-remote, but MONEY_SERVICE_URL is not set: set ' +
          'MONEY_SERVICE_URL to the money service, or leave money-remote out and load the money ' +
          'modules here.',
      );
    }
    return null;
  }
  if (
    process.env['NODE_ENV'] === 'production' &&
    new URL(url).protocol !== 'https:' &&
    process.env['MONEY_SERVICE_ALLOW_HTTP'] !== 'true'
  ) {
    throw new Error(
      'MONEY_SERVICE_URL is not https in production, so balances and limit writes would cross ' +
        'the network in clear text. Use https, or set MONEY_SERVICE_ALLOW_HTTP=true where a ' +
        'service mesh inside the private network encrypts the hop.',
    );
  }
  return createInternalClient({
    baseUrl: url,
    serviceName: process.env['SERVICE_NAME'] || 'monolith',
    audience: process.env['MONEY_SERVICE_NAME'] || 'money',
    secrets: process.env['INTERNAL_API_SECRETS'],
    timeoutMs: MONEY_CALL_TIMEOUT_MS,
  });
}

/**
 * Binds the money ports platform modules read to the money service's internal API (ADR-0063),
 * for a process that drops the money modules because `MONEY_SERVICE_URL` is set. The two
 * projection writers carry `remote: true`, so ADR-0062's rules apply: a lift or loosening
 * reaches the ledger by its event, and the ledger refuses on a stale heartbeat.
 */
export default {
  id: 'money-remote',
  register(ctx) {
    const client = moneyClient();
    if (!client) {
      return;
    }
    ctx.provide(WALLET_READER, () => remoteMoneyPort<WalletReader>(client, 'WALLET_READER'));
    ctx.provide(EXCHANGE_RATE_READER, () =>
      remoteMoneyPort<ExchangeRateReader>(client, 'EXCHANGE_RATE_READER'),
    );
    ctx.provide(ADMIN_WALLET_REPORTING, () =>
      remoteMoneyPort<AdminWalletReporting>(client, 'ADMIN_WALLET_REPORTING'),
    );
    ctx.provide(ADMIN_GAME_REPORTING, () =>
      remoteMoneyPort<AdminGameReporting>(client, 'ADMIN_GAME_REPORTING'),
    );
    ctx.provide(MONEY_REPORTING, () =>
      remoteMoneyPort<MoneyReportingPort>(client, 'MONEY_REPORTING'),
    );
    ctx.provide(PLAYER_RANK_READER, () =>
      remoteMoneyPort<PlayerRankReader>(client, 'PLAYER_RANK_READER'),
    );
    ctx.provideSealed(PLAY_ELIGIBILITY_PROJECTION, () =>
      remoteMoneyPort<PlayEligibilityProjectionPort>(client, 'PLAY_ELIGIBILITY_PROJECTION'),
    );
    ctx.provideSealed(RG_LIMIT_LEDGER, () =>
      remoteMoneyPort<RgLimitLedgerPort>(client, 'RG_LIMIT_LEDGER'),
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;
