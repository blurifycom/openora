import { createFileRoute } from '@tanstack/react-router';
import { PlayersDashboardPage } from '@oss/react-sdk';

export const Route = createFileRoute('/_authed/players/dashboard')({
  component: PlayersDashboardRoute,
});

function PlayersDashboardRoute() {
  return <PlayersDashboardPage listHref="/players" />;
}
