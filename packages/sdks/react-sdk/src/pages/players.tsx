'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { PlayerSchema, PlayerStatusSchema } from '@oss/orpc-contract';
import type { z } from 'zod';
import { useOrpcClient } from '../hooks/use-orpc-client.js';
import { useUI } from '../ui-provider.js';
import { usePlayersColumns } from '../ui-plugin/registry.js';

type Row = z.infer<typeof PlayerSchema> & Record<string, unknown>;
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
  const pluginColumns = usePlayersColumns();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>('');
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ['player', 'list', { page, search, status }],
    queryFn: () =>
      client.player.list({
        page,
        limit: PAGE_SIZE,
        search: search || undefined,
        status: (status || undefined) as Row['status'] | undefined,
      }),
    placeholderData: keepPreviousData,
  });

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rows: Row[] = (data?.players ?? []) as Row[];

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
  ] as const;

  const tail = {
    key: 'id',
    header: '',
    render: (v: unknown) => (
      <Button size="sm" variant="ghost" onClick={() => router.push(`${basePath}/${v as string}`)}>
        View
      </Button>
    ),
  };

  const columns = [
    ...baseColumns,
    ...(pluginColumns as unknown as typeof baseColumns),
    tail,
  ] as Parameters<typeof DataTable<Row>>[0]['columns'];

  return (
    <>
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
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          <Button
            size="sm"
            variant={status === '' ? 'primary' : 'outline'}
            onClick={() => {
              setStatus('');
              setPage(1);
            }}
          >
            All
          </Button>
          {STATUSES.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={status === s ? 'primary' : 'outline'}
              onClick={() => {
                setStatus(s);
                setPage(1);
              }}
            >
              {s.replace('_', ' ')}
            </Button>
          ))}
        </div>
      </div>

      <DataTable<Row>
        data={rows}
        loading={isLoading}
        emptyMessage="No players match."
        columns={columns}
      />

      <div className="pagination">
        <span className="muted">
          Page {page} of {totalPages}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          Prev
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={page >= totalPages}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </Button>
      </div>
    </>
  );
}
