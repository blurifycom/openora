import type { UIProvider } from '@oss/ui-provider-contract';

type LimitRow = {
  id: string;
  type: string;
  amount: number;
  period: string;
};

type LimitRecord = Record<string, unknown> & LimitRow;

interface LimitsPanelProps {
  ui: UIProvider;
  limits: LimitRow[];
}

export function LimitsPanel({ ui, limits }: LimitsPanelProps) {
  const { DataTable } = ui;
  return (
    <DataTable<LimitRecord>
      data={limits as LimitRecord[]}
      columns={[
        { key: 'type', header: 'Type' },
        { key: 'amount', header: 'Amount' },
        { key: 'period', header: 'Period' },
      ]}
      emptyMessage="No limits set"
    />
  );
}
