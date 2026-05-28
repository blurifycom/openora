'use client';

import { useQuery } from '@tanstack/react-query';
import { GameSchema } from '@oss/orpc-contract';
import type { z } from 'zod';
import { useOrpcClient } from '@oss/react-hooks';
import { useUI } from '@oss/react-hooks';
import { useSlotColumns, SLOTS } from '../ui-plugin/index.js';

type Row = z.infer<typeof GameSchema> & Record<string, unknown>;

export function GamesPage() {
  const client = useOrpcClient();
  const { Badge, DataTable } = useUI();
  const pluginColumns = useSlotColumns(SLOTS.games.columns);

  const { data, isLoading } = useQuery({
    queryKey: ['gaming', 'games'],
    queryFn: () => client.gaming.listGames(),
  });

  const rows: Row[] = (data ?? []) as Row[];

  const baseColumns = [
    { key: 'name', header: 'Name' },
    {
      key: 'provider',
      header: 'Provider',
      render: (v: unknown) => <Badge variant="outline">{v as string}</Badge>,
    },
    { key: 'category', header: 'Category', render: (v: unknown) => <Badge>{v as string}</Badge> },
    {
      key: 'isActive',
      header: 'Status',
      render: (v: unknown) => (
        <Badge variant={v ? 'success' : 'destructive'}>{v ? 'Live' : 'Disabled'}</Badge>
      ),
    },
    {
      key: 'id',
      header: 'ID',
      render: (v: unknown) => <code className="muted">{v as string}</code>,
    },
  ] as const;

  const columns = [
    ...baseColumns,
    ...(pluginColumns as unknown as typeof baseColumns),
  ] as Parameters<typeof DataTable<Row>>[0]['columns'];

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-header__title">Games</h1>
          <div className="page-header__hint">
            Read-through to the <code>gaming.listGames</code> endpoint - what players see in the
            lobby.
          </div>
        </div>
      </div>

      <DataTable<Row>
        data={rows}
        loading={isLoading}
        emptyMessage="No games seeded. Run a seed script or POST via /gaming."
        columns={columns}
      />
    </>
  );
}
