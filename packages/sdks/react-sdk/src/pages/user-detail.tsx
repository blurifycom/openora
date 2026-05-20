'use client';

import { Fragment, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminTransactionSchema } from '@oss/orpc-contract';
import type { z } from 'zod';
import { useOrpcClient } from '../hooks/use-orpc-client.js';
import { useUI } from '../ui-provider.js';
import { useUserDetailActions, useUserDetailSections } from '../ui-plugin/registry.js';
import { SkeletonDetail } from '../shell/skeleton.js';

type AdminTransaction = z.infer<typeof AdminTransactionSchema>;
type TxRow = AdminTransaction & Record<string, unknown>;

const ROLES = ['user', 'admin', 'support'] as const;

export function UserDetailPage({ id, usersPath = '/users' }: { id: string; usersPath?: string }) {
  const client = useOrpcClient();
  const queryClient = useQueryClient();
  const { Card, Button, Badge, Dialog, DataTable } = useUI();
  const pluginSections = useUserDetailSections();
  const pluginActions = useUserDetailActions();

  const userQuery = useQuery({
    queryKey: ['backoffice', 'user', id],
    queryFn: () => client.backoffice.getUser({ userId: id }),
  });

  const txQuery = useQuery({
    queryKey: ['backoffice', 'transactions', { userId: id }],
    queryFn: () => client.backoffice.listTransactions({ userId: id, limit: 10 }),
  });

  const [editOpen, setEditOpen] = useState(false);
  const [draftActive, setDraftActive] = useState(true);
  const [draftRole, setDraftRole] = useState('user');

  const openEdit = (): void => {
    if (!userQuery.data) return;
    setDraftActive(userQuery.data.isActive);
    setDraftRole(userQuery.data.role);
    setEditOpen(true);
  };

  const updateMut = useMutation({
    mutationFn: (input: { isActive: boolean; role: string }) =>
      client.backoffice.updateUser({ userId: id, ...input }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backoffice', 'user', id] });
      queryClient.invalidateQueries({ queryKey: ['backoffice', 'users'] });
      setEditOpen(false);
    },
  });

  const user = userQuery.data;

  if (userQuery.isLoading) return <SkeletonDetail />;
  if (userQuery.isError || !user)
    return (
      <div>
        <Link href={usersPath}>← Back to users</Link>
        <div className="muted" style={{ marginTop: '1rem' }}>
          User not found.
        </div>
      </div>
    );

  const txRows: TxRow[] = (txQuery.data?.transactions ?? []) as TxRow[];

  return (
    <>
      <div className="page-header">
        <div>
          <Link href={usersPath} className="muted">
            ← Users
          </Link>
          <h1 className="page-header__title">{user.name ?? user.email}</h1>
          <div className="page-header__hint">{user.email}</div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {pluginActions.map((a) => (
            <Fragment key={a.id}>{a.render(user)}</Fragment>
          ))}
          <Button onClick={openEdit}>Edit</Button>
        </div>
      </div>

      <Card>
        <div style={{ padding: '1.25rem' }}>
          <div className="detail-grid">
            <div className="detail-grid__label">User ID</div>
            <div>
              <code>{user.id}</code>
            </div>
            <div className="detail-grid__label">Role</div>
            <div>
              <Badge variant="outline">{user.role}</Badge>
            </div>
            <div className="detail-grid__label">Status</div>
            <div>
              <Badge variant={user.isActive ? 'success' : 'destructive'}>
                {user.isActive ? 'Active' : 'Suspended'}
              </Badge>
            </div>
            <div className="detail-grid__label">Joined</div>
            <div>{new Date(user.createdAt).toLocaleString()}</div>
          </div>
        </div>
      </Card>

      {pluginSections.map((s) => (
        <section key={s.id} className="section">
          <h2 className="section__title">{s.title}</h2>
          {s.render(user)}
        </section>
      ))}

      <section className="section">
        <h2 className="section__title">Recent transactions</h2>
        <DataTable<TxRow>
          data={txRows}
          loading={txQuery.isLoading}
          emptyMessage="No transactions yet."
          columns={[
            { key: 'type', header: 'Type', render: (v) => <Badge>{v as string}</Badge> },
            {
              key: 'amount',
              header: 'Amount',
              render: (v, row) =>
                `${(v as number).toFixed(2)} ${(row as AdminTransaction).currency}`,
            },
            {
              key: 'status',
              header: 'Status',
              render: (v) => {
                const s = v as string;
                const variant =
                  s === 'completed' ? 'success' : s === 'failed' ? 'destructive' : 'warning';
                return <Badge variant={variant}>{s}</Badge>;
              },
            },
            {
              key: 'createdAt',
              header: 'When',
              render: (v) => new Date(v as string).toLocaleString(),
            },
          ]}
        />
      </section>

      <Dialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="Edit user"
        description={user.email}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="checkbox"
              checked={draftActive}
              onChange={(e) => setDraftActive(e.target.checked)}
            />
            <span>Active</span>
          </label>

          <div>
            <div style={{ fontSize: '0.85rem', marginBottom: '0.25rem' }}>Role</div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {ROLES.map((r) => (
                <Button
                  key={r}
                  size="sm"
                  variant={draftRole === r ? 'primary' : 'outline'}
                  onClick={() => setDraftRole(r)}
                  type="button"
                >
                  {r}
                </Button>
              ))}
            </div>
          </div>

          {updateMut.error instanceof Error && (
            <div className="auth-screen__error">{updateMut.error.message}</div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
            <Button variant="ghost" onClick={() => setEditOpen(false)} type="button">
              Cancel
            </Button>
            <Button
              loading={updateMut.isPending}
              onClick={() => updateMut.mutate({ isActive: draftActive, role: draftRole })}
              type="button"
            >
              Save
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
