'use client';

import { useRouter } from 'next/navigation';
import { AdminUserSchema } from '@oss/orpc-contract';
import type { z } from 'zod';
import { useOrpcClient } from '@oss/react-hooks';
import { usePaginatedList } from '@oss/react-hooks';
import { useUI } from '@oss/react-hooks';
import { useSlotColumns, Slot, SLOTS } from '../ui-plugin/index.js';
import { Pagination } from '@oss/react-blocks/admin';

type Row = z.infer<typeof AdminUserSchema> & Record<string, unknown>;

const PAGE_SIZE = 20;

export function UsersListPage({ basePath = '/users' }: { basePath?: string } = {}) {
  const router = useRouter();
  const client = useOrpcClient();
  const { Input, Button, Badge, DataTable } = useUI();
  const pluginColumns = useSlotColumns(SLOTS.users.columns);

  const { items, total, page, setPage, search, setSearch, isLoading, totalPages } =
    usePaginatedList<Row>({
      queryKey: ['backoffice', 'users'],
      queryFn: (p, s) =>
        client.backoffice
          .listUsers({ page: p, limit: PAGE_SIZE, search: s || undefined })
          .then((d) => ({ items: d.users as Row[], total: d.total })),
    });

  const baseColumns = [
    { key: 'email', header: 'Email' },
    {
      key: 'name',
      header: 'Name',
      render: (v: unknown) => (v as string) ?? <span className="muted">-</span>,
    },
    {
      key: 'role',
      header: 'Role',
      render: (v: unknown) => <Badge variant="outline">{v as string}</Badge>,
    },
    {
      key: 'isActive',
      header: 'Status',
      render: (v: unknown) => (
        <Badge variant={v ? 'success' : 'destructive'}>{v ? 'Active' : 'Suspended'}</Badge>
      ),
    },
    {
      key: 'createdAt',
      header: 'Joined',
      render: (v: unknown) => new Date(v as string).toLocaleDateString(),
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

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-header__title">Users</h1>
          <div className="page-header__hint">{total} total</div>
        </div>
      </div>

      <div className="toolbar">
        <Input
          label="Search"
          placeholder="email or name"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Slot name={SLOTS.users.toolbar} />
      </div>

      <DataTable<Row>
        data={items}
        loading={isLoading}
        emptyMessage="No users match."
        columns={columns}
      />

      <Pagination
        page={page}
        totalPages={totalPages}
        onPrev={() => setPage(page - 1)}
        onNext={() => setPage(page + 1)}
      />
    </>
  );
}
