import { createFileRoute } from '@tanstack/react-router';
import { LoginPage } from '@oss/react-sdk';

// Client-driven auth form (TanStack Query mutation). No loader.
export const Route = createFileRoute('/login')({
  component: LoginPage,
});
