import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, loadExtensions } from '@openora/core/server';
import { composeContract, defineIgamingConfig } from '@openora/core/contracts';
import {
  user,
  session,
  account,
  verification,
  twoFactor,
} from '@openora/core/pam/schema/identity';
import { identityContract } from '@openora/core/pam/contracts/identity';
import { complianceContract } from '@openora/core/compliance/contracts';
import { profileContract } from '@openora/core/pam/contracts/profile';
import { cmsContract } from '@openora/core/cms/contracts';
import { notificationsContract } from '@openora/core/engagement/contracts/notifications';
import { bonusContract } from '@openora/core/engagement/contracts/bonus';
import { chatContract } from '@openora/core/engagement/contracts/chat';
import { walletContract } from '@openora/core/wallet/contract';
import { gamingContract } from '@openora/core/casino/contracts/gaming';
import { lobbyContract } from '@openora/core/casino/contracts/lobby';
import { backofficeContract } from '@openora/core/admin-console/contract';
import { iamContract } from '@openora/core/iam/contract';
import { auditContract } from '@openora/core/audit/contract';

const contract = composeContract({
  identity: identityContract,
  cms: cmsContract,
  compliance: complianceContract,
  notifications: notificationsContract,
  wallet: walletContract,
  gaming: gamingContract,
  bonus: bonusContract,
  chat: chatContract,
  lobby: lobbyContract,
  backoffice: backofficeContract,
  profile: profileContract,
  iam: iamContract,
  audit: auditContract,
});

// Declarative platform config, validated at the boundary by defineIgamingConfig.
// Injected app-wide via the IGAMING_CONFIG token so services/adapters can read it.
const igaming = defineIgamingConfig({
  branding: {
    name: '{{name}}',
    themePreset: 'midnightSapphire',
    supportEmail: 'support@{{name}}.example',
  },
  currencies: ['EUR', 'USD'],
  jurisdictions: ['DE', 'GB'],
  blockedCountries: ['US'],
  limits: {
    maxDepositPerDay: 1000,
    maxStakePerBet: 100,
    sessionReminderMinutes: 60,
  },
  providers: {
    payment: 'mock',
  },
});

// loadExtensions() walks up from the working dir; point it at the registry sitting
// next to this entry so booting from any cwd resolves it (it lives under src/, which
// the upward walk would otherwise miss). An explicit env override still wins.
process.env['EXTENSIONS_CONFIG'] ??= resolve(
  dirname(fileURLToPath(import.meta.url)),
  'extensions.config.ts',
);

async function bootstrap() {
  const { listen, emitOpenApiSpec } = await createApp({
    plugins: await loadExtensions(),
    contract,
    authSchema: { user, session, account, verification, twoFactor },
    igaming,
    port: Number(process.env['PORT'] ?? 3001),
    cors: { origins: process.env['CORS_ORIGINS']?.split(',') ?? '*' },
    openapi: { info: { title: '{{name}} API', version: '0.1.0' } },
  });

  await listen();
  await emitOpenApiSpec();
}

void bootstrap();
