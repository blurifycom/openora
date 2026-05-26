import { PlayerDetailPage } from '@oss/react-sdk';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PlayerDetailPage id={id} playersPath="/players" />;
}
