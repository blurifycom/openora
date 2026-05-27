# KYC Adapter

## Interface

```ts
// packages/contracts/adapters/src/kyc.ts
export interface KycAdapter {
  submit(userId: string, documents: KycDocument[]): Promise<KycResult>;
  getStatus(userId: string): Promise<KycStatus>;
}

export interface KycDocument {
  type: 'passport' | 'drivers_license' | 'national_id';
  frontUrl: string;
  backUrl?: string;
}

export type KycStatus = 'pending' | 'approved' | 'rejected' | 'not_started';

export interface KycResult {
  referenceId: string;
  status: KycStatus;
}

export const KYC_ADAPTER = Symbol('KYC_ADAPTER');
```

## Default binding

The `identity` module ships `MockKycAdapter` (auto-approves all submissions). It is bound
at boot via `identity/src/plugin.ts`. This is intentionally permissive for local dev.

## Real provider: SumSub

The intended production provider is [SumSub](https://sumsub.com). To wire it:

1. Create an overlay plugin (or extend an existing one):

```bash
/scaffold-plugin sumsub-kyc
```

2. Implement `KycAdapter` against the SumSub REST API:

```ts
// apps/extensions/sumsub-kyc/src/sumsub-kyc-adapter.ts
import type { KycAdapter, KycDocument, KycResult, KycStatus } from '@oss/adapters';

export class SumsubKycAdapter implements KycAdapter {
  async submit(userId: string, documents: KycDocument[]): Promise<KycResult> {
    // POST to SumSub applicant API
    // https://developers.sumsub.com/api-reference/#creating-an-applicant
  }

  async getStatus(userId: string): Promise<KycStatus> {
    // GET applicant review status from SumSub
  }
}
```

3. Bind it in the plugin, AFTER `identity` in `extensions.config.ts` (last registration wins):

```ts
// apps/extensions/sumsub-kyc/plugin.ts
import { KYC_ADAPTER } from '@oss/adapters';
import { definePlugin } from '@oss/plugin-host';
import { SumsubKycAdapter } from './src/sumsub-kyc-adapter.js';

export default definePlugin({
  id: 'sumsub-kyc',
  dependsOn: ['identity'],
  register(ctx) {
    ctx.provide(KYC_ADAPTER, () => new SumsubKycAdapter());
  },
});
```

4. Register in `extensions.config.ts` **after** the `identity` entry.

## Webhook considerations

SumSub sends async review results via webhook. Handle them in a separate HTTP endpoint
(add a route to the overlay's router) and update the player's KYC status via the
`identity` module's service or a dedicated `kyc_status` table in the overlay's schema.
