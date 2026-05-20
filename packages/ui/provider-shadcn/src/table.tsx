import type {
  TableProps,
  TableBodyProps,
  TableHeadProps,
  TableRowProps,
  TableCellProps,
  TableHeaderCellProps,
} from '@oss/ui-provider-contract';

export function Table({ children, ...props }: TableProps) {
  return <table {...props}>{children}</table>;
}

export function TableHead({ children }: TableHeadProps) {
  return <thead>{children}</thead>;
}

export function TableBody({ children }: TableBodyProps) {
  return <tbody>{children}</tbody>;
}

export function TableRow({ children, className }: TableRowProps) {
  return <tr className={className}>{children}</tr>;
}

export function TableCell({ children, ...props }: TableCellProps) {
  return <td {...props}>{children}</td>;
}

export function TableHeaderCell({ children, ...props }: TableHeaderCellProps) {
  return <th {...props}>{children}</th>;
}
