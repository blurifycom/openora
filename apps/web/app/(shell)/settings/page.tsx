import { PlayerSettingsPage } from '@oss/react-pages';

// Client-driven forms (profile, password, 2FA); render dynamically.
export const dynamic = 'force-dynamic';

export default function Page() {
  return <PlayerSettingsPage />;
}
