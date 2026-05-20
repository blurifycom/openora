import type {
  ComponentType,
  ReactNode,
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from 'react';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'destructive' | 'outline';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
};

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  error?: string;
};

export type CardProps = {
  children: ReactNode;
  className?: string;
};

export type BadgeProps = {
  children: ReactNode;
  variant?: 'default' | 'success' | 'warning' | 'destructive' | 'outline';
  className?: string;
};

export type DialogProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: ReactNode;
};

export type ToastVariant = 'default' | 'success' | 'error' | 'warning';

export type ToastProps = {
  id: string;
  title: string;
  description?: string;
  variant?: ToastVariant;
  duration?: number;
};

export type UseToastReturn = {
  toasts: ToastProps[];
  toast: (props: Omit<ToastProps, 'id'>) => void;
  dismiss: (id: string) => void;
};

export type TableColumn<T> = {
  key: keyof T & string;
  header: string;
  render?: (value: T[keyof T], row: T) => ReactNode;
};

export type DataTableProps<T extends Record<string, unknown>> = {
  data: T[];
  columns: TableColumn<T>[];
  loading?: boolean;
  emptyMessage?: string;
  className?: string;
};

export type TableProps = TableHTMLAttributes<HTMLTableElement> & {
  children: ReactNode;
};

export type TableBodyProps = { children: ReactNode };
export type TableHeadProps = { children: ReactNode };
export type TableRowProps = { children: ReactNode; className?: string };
export type TableCellProps = TdHTMLAttributes<HTMLTableCellElement> & { children: ReactNode };
export type TableHeaderCellProps = ThHTMLAttributes<HTMLTableCellElement> & { children: ReactNode };

export type UIProvider = {
  Button: ComponentType<ButtonProps>;
  Input: ComponentType<InputProps>;
  Card: ComponentType<CardProps>;
  Badge: ComponentType<BadgeProps>;
  Dialog: ComponentType<DialogProps>;
  DataTable: <T extends Record<string, unknown>>(props: DataTableProps<T>) => ReactNode;
  Table: ComponentType<TableProps>;
  TableBody: ComponentType<TableBodyProps>;
  TableHead: ComponentType<TableHeadProps>;
  TableRow: ComponentType<TableRowProps>;
  TableCell: ComponentType<TableCellProps>;
  TableHeaderCell: ComponentType<TableHeaderCellProps>;
  useToast: () => UseToastReturn;
};

export type { UIProvider as default };
