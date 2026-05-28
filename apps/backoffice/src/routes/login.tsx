import { createFileRoute } from '@tanstack/react-router';
import { LoginPage } from '@oss/react-pages';

// Sits outside the `_authed` layout, so it renders without the AuthGuard.
export const Route = createFileRoute('/login')({
  component: LoginPage,
});
