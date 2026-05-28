'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useOrpcClient } from '@oss/react-hooks';
import { useUI } from '@oss/react-hooks';
import { StatCard } from '@oss/react-blocks/admin';
import { Skeleton } from '@oss/react-blocks/admin';
import { TimeSeriesChart } from '@oss/react-blocks/admin';

const WINDOWS = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
] as const;

/**
 * Players analytics dashboard - the "comparative method" view: registrations
 * over time (chart) plus headline counts including new players in the last week.
 */
export function PlayersDashboardPage({ listHref }: { listHref?: string } = {}) {
  const client = useOrpcClient();
  const router = useRouter();
  const { Button } = useUI();
  const [days, setDays] = useState(30);

  const summary = useQuery({
    queryKey: ['player', 'summary'],
    queryFn: () => client.player.summary(),
  });

  const series = useQuery({
    queryKey: ['player', 'registrations', days],
    queryFn: () => client.player.registrationsOverTime({ days }),
  });

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-header__title">Players</h1>
          <div className="page-header__hint">Acquisition & lifecycle overview</div>
        </div>
        {listHref && (
          <Button variant="outline" size="sm" onClick={() => router.push(listHref)}>
            All players →
          </Button>
        )}
      </div>

      <div className="stat-grid">
        <StatCard
          label="Total players"
          loading={summary.isLoading}
          value={(summary.data?.total ?? 0).toLocaleString()}
        />
        <StatCard
          label="New (last 7 days)"
          loading={summary.isLoading}
          value={(summary.data?.newLastWeek ?? 0).toLocaleString()}
          {...(summary.data && summary.data.total > 0
            ? {
                hint: `${Math.round(((summary.data.newLastWeek ?? 0) / summary.data.total) * 100)}% of base`,
              }
            : {})}
        />
        <StatCard
          label="Active"
          loading={summary.isLoading}
          value={(summary.data?.active ?? 0).toLocaleString()}
        />
        <StatCard
          label="Self-excluded"
          loading={summary.isLoading}
          value={(summary.data?.selfExcluded ?? 0).toLocaleString()}
        />
      </div>

      <section className="section">
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            marginBottom: '1.25rem',
          }}
        >
          <h2 className="section__title" style={{ border: 'none', margin: 0, padding: 0 }}>
            Registrations over time
          </h2>
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            {WINDOWS.map((w) => (
              <Button
                key={w.days}
                size="sm"
                variant={days === w.days ? 'primary' : 'outline'}
                onClick={() => setDays(w.days)}
              >
                {w.label}
              </Button>
            ))}
          </div>
        </div>
        {series.isError ? (
          <div className="muted">
            Failed to load. Is the API reachable and are you signed in as an admin?
          </div>
        ) : series.isLoading ? (
          <div className="chart">
            <div className="chart__header">
              <Skeleton width="8rem" height="0.7rem" />
              <Skeleton width="4rem" height="0.7rem" />
            </div>
            <Skeleton width="100%" height="160px" />
          </div>
        ) : (
          <TimeSeriesChart data={series.data ?? []} label={`Last ${days} days`} />
        )}
      </section>
    </>
  );
}
