import { UserDetailPage } from '@oss/react-sdk';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <UserDetailPage id={id} />;
}
