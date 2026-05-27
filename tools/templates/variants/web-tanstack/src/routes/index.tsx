import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { PlayerLobbyPage } from '@oss/react-sdk';
import { fetchLobbyData, type LobbyData } from '@oss/react-sdk/server';
import { serverFetchOptions } from '../server/api';

// Server function: runs on the server, forwards cookies, returns the lobby data.
const getLobbyData = createServerFn({ method: 'GET' }).handler(
  (): Promise<LobbyData> => fetchLobbyData(serverFetchOptions()),
);

export const Route = createFileRoute('/')({
  loader: () => getLobbyData(),
  component: LobbyRoute,
});

function LobbyRoute() {
  const initialData = Route.useLoaderData();
  return <PlayerLobbyPage initialData={initialData} />;
}
