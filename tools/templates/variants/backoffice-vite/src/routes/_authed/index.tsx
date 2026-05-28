import { createFileRoute } from '@tanstack/react-router';
import { DashboardPage } from '@oss/react-pages';

export const Route = createFileRoute('/_authed/')({
  component: DashboardPage,
});
