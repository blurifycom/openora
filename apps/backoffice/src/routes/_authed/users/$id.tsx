import { createFileRoute } from '@tanstack/react-router';
import { UserDetailPage } from '@oss/react-pages';

export const Route = createFileRoute('/_authed/users/$id')({
  component: UserDetailRoute,
});

function UserDetailRoute() {
  const { id } = Route.useParams();
  return <UserDetailPage id={id} />;
}
