'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PlayerSchema, PlayerStatusSchema } from '@oss/orpc-contract';
import type { z } from 'zod';
import { useOrpcClient, PageContextProvider } from '@oss/react-hooks';
import { usePaginatedList } from '@oss/react-hooks';
import { useUI } from '@oss/react-hooks';
import { Slot, useSlotColumns, SLOTS } from '../ui-plugin/index.js';
import { Pagination } from '@oss/react-blocks/admin';

type Row = z.infer<typeof PlayerSchema> & Record<string, unknown>;

/**
 * Page-scoped data shape exposed to plugin slot contributors via usePageContext.
 *
 *   const { rows, total, statusFilter } = usePageContext<PlayersListPageContext>();
 *
 * A `players:toolbar` fill that needs to know what's selected (eg batch
 * actions on the current filtered set) reads from this context.
 */
export type PlayersListPageContext = {
  rows: Row[];
  total: number;
  page: number;
  isLoading: boolean;
  search: string;
  statusFilter: string;
};
const STATUSES = PlayerStatusSchema.options;
const PAGE_SIZE = 20;

const statusVariant = (s: string): 'success' | 'warning' | 'destructive' | 'default' =>
  s === 'active'
    ? 'success'
    : s === 'self_excluded' || s === 'suspended' || s === 'closed'
      ? 'destructive'
      : 'warning';

export function PlayersListPage({
  basePath = '/players',
  analyticsHref,
}: { basePath?: string; analyticsHref?: string } = {}) {
  const router = useRouter();
  const client = useOrpcClient();
  const { Input, Button, Badge, DataTable } = useUI();
  const pluginColumns = useSlotColumns(SLOTS.players.columns);
  const [status, setStatus] = useState('');

  const { items, total, page, setPage, search, setSearch, isLoading, totalPages } =
    usePaginatedList<Row>({
      queryKey: ['player', 'list', { status }],
      queryFn: (p, s) =>
        client.player
          .list({
            page: p,
            limit: PAGE_SIZE,
            search: s || undefined,
            status: (status || undefined) as Row['status'] | undefined,
          })
          .then((d) => ({ items: d.players as Row[], total: d.total })),
    });

  const baseColumns = [
    { key: 'displayName', header: 'Player' },
    {
      key: 'email',
      header: 'Email',
      render: (v: unknown) => (v as string) || <span className="muted">-</span>,
    },
    {
      key: 'country',
      header: 'Country',
      render: (v: unknown) => (v as string) ?? <span className="muted">-</span>,
    },
    {
      key: 'level',
      header: 'Level',
      render: (v: unknown) => <Badge variant="outline">L{v as number}</Badge>,
    },
    {
      key: 'kycStatus',
      header: 'KYC',
      render: (v: unknown) => (
        <Badge
          variant={v === 'verified' ? 'success' : v === 'rejected' ? 'destructive' : 'warning'}
        >
          {v as string}
        </Badge>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (v: unknown) => (
        <Badge variant={statusVariant(v as string)}>{(v as string).replace('_', ' ')}</Badge>
      ),
    },
    {
      key: 'id',
      header: '',
      render: (v: unknown) => (
        <Button size="sm" variant="ghost" onClick={() => router.push(`${basePath}/${v as string}`)}>
          View
        </Button>
      ),
    },
  ] as const;

  const columns = [
    ...baseColumns,
    ...(pluginColumns as unknown as typeof baseColumns),
  ] as Parameters<typeof DataTable<Row>>[0]['columns'];

  const pageContext = useMemo<PlayersListPageContext>(
    () => ({
      rows: items,
      total,
      page,
      isLoading,
      search,
      statusFilter: status,
    }),
    [items, total, page, isLoading, search, status],
  );

  return (
    <PageContextProvider<PlayersListPageContext> value={pageContext}>
      <div className="page-header">
        <div>
          <h1 className="page-header__title">Players</h1>
          <div className="page-header__hint">{total} total</div>
        </div>
        {analyticsHref && (
          <Button variant="outline" size="sm" onClick={() => router.push(analyticsHref)}>
            Analytics →
          </Button>
        )}
      </div>

      <div className="toolbar">
        <Input
          label="Search"
          placeholder="name or user id"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          <Button
            size="sm"
            variant={status === '' ? 'primary' : 'outline'}
            onClick={() => { setStatus(''); setPage(1); }}
          >
            All
          </Button>
          {STATUSES.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={status === s ? 'primary' : 'outline'}
              onClick={() => { setStatus(s); setPage(1); }}
            >
              {s.replace('_', ' ')}
            </Button>
          ))}
        </div>
        <Slot name={SLOTS.players.toolbar} />
      </div>

      <DataTable<Row>
        data={items}
        loading={isLoading}
        emptyMessage="No players match."
        columns={columns}
      />

      <Pagination
        page={page}
        totalPages={totalPages}
        onPrev={() => setPage(page - 1)}
        onNext={() => setPage(page + 1)}
      />
    </PageContextProvider>
  );
}
