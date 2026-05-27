import { createFileRoute } from '@tanstack/react-router';
import { UsersListPage } from '@oss/react-sdk';

export const Route = createFileRoute('/_authed/users')({
  component: UsersListPage,
});
