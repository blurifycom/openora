import type { Meta, StoryObj } from '@storybook/react';
import { useUI } from '../.storybook/adapters';

type UserRow = {
  email: string;
  role: string;
  isActive: boolean;
  joined: string;
} & Record<string, unknown>;

const rows: UserRow[] = [
  { email: 'ada@igaming.dev', role: 'admin', isActive: true, joined: '2026-01-12' },
  { email: 'grace@igaming.dev', role: 'support', isActive: true, joined: '2026-02-03' },
  { email: 'alan@igaming.dev', role: 'user', isActive: false, joined: '2026-03-21' },
];

const meta: Meta = {
  title: 'Components/DataTable',
};
export default meta;

export const Users: StoryObj = {
  render: () => {
    const { DataTable, Badge } = useUI();
    return (
      <DataTable<UserRow>
        data={rows}
        columns={[
          { key: 'email', header: 'Email' },
          {
            key: 'role',
            header: 'Role',
            render: (v) => <Badge variant="outline">{v as string}</Badge>,
          },
          {
            key: 'isActive',
            header: 'Status',
            render: (v) => (
              <Badge variant={v ? 'success' : 'destructive'}>{v ? 'Active' : 'Suspended'}</Badge>
            ),
          },
          { key: 'joined', header: 'Joined' },
        ]}
      />
    );
  },
};

export const Loading: StoryObj = {
  render: () => {
    const { DataTable } = useUI();
    return <DataTable<UserRow> data={[]} loading columns={[{ key: 'email', header: 'Email' }]} />;
  },
};

export const Empty: StoryObj = {
  render: () => {
    const { DataTable } = useUI();
    return (
      <DataTable<UserRow>
        data={[]}
        emptyMessage="No users match your filter."
        columns={[{ key: 'email', header: 'Email' }]}
      />
    );
  },
};
