'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { WalletTransactionSchema } from '@oss/orpc-contract';
import type { z } from 'zod';
import { createClient } from '../../client.js';
import { useApiClient } from '../../context/api-client.js';
import { useCurrentUser } from '../../hooks/auth.js';
import { useUI } from '../../ui-provider.js';

type Tx = z.infer<typeof WalletTransactionSchema> & Record<string, unknown>;

// Player wallet: balance + transaction history. The wallet module identifies the
// player by the `x-user-id` header, so we build a header-aware client from the
// current user. (Pattern a downstream player app copies.)
export function PlayerWalletPage() {
  const { baseUrl } = useApiClient();
  const { data: user } = useCurrentUser();
  const { Card, Badge, DataTable } = useUI();

  const userId = user?.id;
  const client = useMemo(
    () =>
      createClient({
        baseUrl,
        headers: () => (userId ? { 'x-user-id': userId } : {}),
      }),
    [baseUrl, userId],
  );

  const balance = useQuery({
    queryKey: ['wallet', 'balance', userId],
    queryFn: () => client.wallet.getBalance(),
    enabled: Boolean(userId),
  });
  const transactions = useQuery({
    queryKey: ['wallet', 'transactions', userId],
    queryFn: () => client.wallet.listTransactions(),
    enabled: Boolean(userId),
  });

  const rows: Tx[] = (transactions.data ?? []) as Tx[];

  const columns = [
    {
      key: 'type',
      header: 'Type',
      render: (v: unknown) => <Badge variant="outline">{v as string}</Badge>,
    },
    { key: 'amount', header: 'Amount' },
    { key: 'currency', header: 'Currency' },
    {
      key: 'status',
      header: 'Status',
      render: (v: unknown) => (
        <Badge variant={v === 'completed' ? 'success' : v === 'failed' ? 'destructive' : 'default'}>
          {v as string}
        </Badge>
      ),
    },
    { key: 'createdAt', header: 'Date' },
  ] as Parameters<typeof DataTable<Tx>>[0]['columns'];

  if (!userId) {
    return (
      <>
        <div className="page-header">
          <h1 className="page-header__title">Wallet</h1>
        </div>
        <p className="muted">Sign in to view your balance and transactions.</p>
      </>
    );
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-header__title">Wallet</h1>
          <div className="page-header__hint">
            Balance and history from the player <code>wallet.*</code> endpoints.
          </div>
        </div>
      </div>

      <Card className="player-balance">
        <div className="player-balance__label">Balance</div>
        <div className="player-balance__amount">
          {balance.isLoading
            ? '...'
            : balance.data
              ? `${balance.data.balance.toFixed(2)} ${balance.data.currency}`
              : '-'}
        </div>
      </Card>

      <h2 className="player-section__title">Transactions</h2>
      <DataTable<Tx>
        data={rows}
        loading={transactions.isLoading}
        emptyMessage="No transactions yet."
        columns={columns}
      />
    </>
  );
}
