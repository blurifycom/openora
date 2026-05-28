import { createFileRoute } from '@tanstack/react-router';
import { PlayersListPage } from '@oss/react-sdk';

export const Route = createFileRoute('/_authed/players/')({
  component: PlayersListPage,
});
