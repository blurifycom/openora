import type {
  TableProps,
  TableBodyProps,
  TableHeadProps,
  TableRowProps,
  TableCellProps,
  TableHeaderCellProps,
} from '@oss/ui-provider-contract';
import { cx } from './cx.js';

export function Table({ children, className, ...props }: TableProps) {
  return (
    <table {...props} className={cx('table', className)}>
      {children}
    </table>
  );
}

export function TableHead({ children }: TableHeadProps) {
  return <thead>{children}</thead>;
}

export function TableBody({ children }: TableBodyProps) {
  return <tbody>{children}</tbody>;
}

export function TableRow({ children, className }: TableRowProps) {
  return <tr className={cx('hover', className)}>{children}</tr>;
}

export function TableCell({ children, ...props }: TableCellProps) {
  return <td {...props}>{children}</td>;
}

export function TableHeaderCell({ children, ...props }: TableHeaderCellProps) {
  return <th {...props}>{children}</th>;
}
