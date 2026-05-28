import { createFileRoute } from '@tanstack/react-router';
import { PlayersListPage } from '@oss/react-pages';

export const Route = createFileRoute('/_authed/players/')({
  component: PlayersListPage,
});
