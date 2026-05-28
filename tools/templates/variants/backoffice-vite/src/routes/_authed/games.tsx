import { createFileRoute } from '@tanstack/react-router';
import { GamesPage } from '@oss/react-pages';

export const Route = createFileRoute('/_authed/games')({
  component: GamesPage,
});
