import { createFileRoute } from '@tanstack/react-router';
import { PlayerDetailPage } from '@oss/react-pages';

export const Route = createFileRoute('/_authed/players/$id')({
  component: PlayerDetailRoute,
});

function PlayerDetailRoute() {
  const { id } = Route.useParams();
  return <PlayerDetailPage id={id} playersPath="/players" />;
}
