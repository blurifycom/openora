'use client';

import { Fragment, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { AdminUserSchema } from '@oss/orpc-contract';
import type { z } from 'zod';
import { useOrpcClient } from '../hooks/use-orpc-client.js';
import { useUI } from '../ui-provider.js';
import { useUsersColumns, useUsersToolbar } from '../ui-plugin/registry.js';

type Row = z.infer<typeof AdminUserSchema> & Record<string, unknown>;

const PAGE_SIZE = 20;

export function UsersListPage({ basePath = '/users' }: { basePath?: string } = {}) {
  const router = useRouter();
  const client = useOrpcClient();
  const { Input, Button, Badge, DataTable } = useUI();
  const pluginColumns = useUsersColumns();
  const pluginToolbar = useUsersToolbar();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ['backoffice', 'users', { page, search }],
    queryFn: () =>
      client.backoffice.listUsers({ page, limit: PAGE_SIZE, search: search || undefined }),
    placeholderData: keepPreviousData,
  });

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rows: Row[] = (data?.users ?? []) as Row[];

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
  ] as const;

  const tailColumn = {
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
    tailColumn,
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
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        {pluginToolbar.map((t) => (
          <Fragment key={t.id}>{t.render()}</Fragment>
        ))}
      </div>

      <DataTable<Row>
        data={rows}
        loading={isLoading}
        emptyMessage="No users match."
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
