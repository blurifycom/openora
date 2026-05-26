import type { UIProvider, TableColumn } from '@oss/ui-provider-contract';

interface TranslationRow {
  key: string;
  value: string;
}

interface TranslationTableProps {
  ui: UIProvider;
  translations: TranslationRow[];
}

const COLUMNS: TableColumn<Record<string, unknown>>[] = [
  { key: 'key', header: 'Key' },
  { key: 'value', header: 'Value' },
];

export function TranslationTable({ ui, translations }: TranslationTableProps) {
  const { DataTable } = ui;
  return (
    <DataTable
      data={translations as unknown as Record<string, unknown>[]}
      columns={COLUMNS}
      emptyMessage="No translations found."
    />
  );
}
