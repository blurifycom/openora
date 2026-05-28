import { Outlet, createFileRoute } from '@tanstack/react-router';
import { AppShell, AuthGuard } from '@oss/react-sdk';

// Pathless layout: every admin page renders inside the auth guard + admin shell.
// `/login` is a sibling top-level route, so it stays outside this guard.
export const Route = createFileRoute('/_authed')({
  component: AuthedLayout,
});

function AuthedLayout() {
  return (
    <AuthGuard>
      <AppShell>
        <Outlet />
      </AppShell>
    </AuthGuard>
  );
}
