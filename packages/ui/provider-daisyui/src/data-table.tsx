import type { DataTableProps } from '@oss/ui-provider-contract';
import { cx } from './cx.js';
import { Table, TableHead, TableBody, TableRow, TableCell, TableHeaderCell } from './table.js';

export function DataTable<T extends Record<string, unknown>>({
  data,
  columns,
  loading = false,
  emptyMessage = 'No results.',
  className,
}: DataTableProps<T>) {
  return (
    <div className={cx('overflow-x-auto', className)}>
      <Table>
        <TableHead>
          <TableRow>
            {columns.map((col) => (
              <TableHeaderCell key={col.key}>{col.header}</TableHeaderCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {loading ? (
            Array.from({ length: 6 }).map((_, r) => (
              <TableRow key={`skeleton-${r}`}>
                {columns.map((col) => (
                  <TableCell key={col.key}>
                    <span className="skeleton block h-3 w-3/4" aria-hidden="true" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : data.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length}>{emptyMessage}</TableCell>
            </TableRow>
          ) : (
            data.map((row, i) => (
              <TableRow key={i}>
                {columns.map((col) => (
                  <TableCell key={col.key}>
                    {col.render ? col.render(row[col.key], row) : String(row[col.key] ?? '')}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
