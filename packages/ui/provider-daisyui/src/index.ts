import type { UIProvider } from '@oss/ui-provider-contract';
import { Button } from './button.js';
import { Input } from './input.js';
import { Card } from './card.js';
import { Badge } from './badge.js';
import { Dialog } from './dialog.js';
import { DataTable } from './data-table.js';
import { Table, TableHead, TableBody, TableRow, TableCell, TableHeaderCell } from './table.js';
import { useToast } from './use-toast.js';

export { Button } from './button.js';
export { Input } from './input.js';
export { Card } from './card.js';
export { Badge } from './badge.js';
export { Dialog } from './dialog.js';
export { DataTable } from './data-table.js';
export { Table, TableHead, TableBody, TableRow, TableCell, TableHeaderCell } from './table.js';
export { useToast } from './use-toast.js';

// Implements @oss/ui-provider-contract with DaisyUI semantic classes (btn, input,
// card, badge, modal, table). Requires Tailwind + the DaisyUI plugin enabled in
// the consuming app's CSS (eg `@plugin "daisyui";` for Tailwind v4).
export const daisyuiProvider: UIProvider = {
  Button,
  Input,
  Card,
  Badge,
  Dialog,
  DataTable,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  TableHeaderCell,
  useToast,
};
