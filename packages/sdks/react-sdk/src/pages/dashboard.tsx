'use client';

import { Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOrpcClient } from '../hooks/use-orpc-client.js';
import { useDashboardTiles } from '../ui-plugin/registry.js';
import { StatCard } from '../shell/stat-card.js';

const money = (n: number): string =>
  n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function DashboardPage() {
  const client = useOrpcClient();
  const tiles = useDashboardTiles();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['backoffice', 'stats'],
    queryFn: () => client.backoffice.getStats(),
  });

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-header__title">Dashboard</h1>
          <div className="page-header__hint">Platform overview</div>
        </div>
      </div>

      {isError && <div className="muted">Failed to load stats. Is the API reachable?</div>}

      <div className="stat-grid">
        <StatCard
          label="Total users"
          loading={isLoading}
          value={data?.totalUsers.toLocaleString() ?? 0}
        />
        <StatCard
          label="Active users"
          loading={isLoading}
          value={data?.activeUsers.toLocaleString() ?? 0}
          {...(data && data.totalUsers > 0
            ? {
                hint: `${Math.round((data.activeUsers / data.totalUsers) * 100)}% of total`,
              }
            : {})}
        />
        <StatCard label="Deposits" loading={isLoading} value={money(data?.totalDeposits ?? 0)} />
        <StatCard
          label="Withdrawals"
          loading={isLoading}
          value={money(data?.totalWithdrawals ?? 0)}
        />
        <StatCard
          label="Bonus claimed"
          loading={isLoading}
          value={money(data?.totalBonusClaimed ?? 0)}
        />
        {tiles.map((t) => (
          <Fragment key={t.id}>{t.render()}</Fragment>
        ))}
      </div>
    </>
  );
}
