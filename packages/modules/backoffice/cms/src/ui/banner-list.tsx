import type { UIProvider } from '@oss/ui-provider-contract';

interface BannerItem {
  id: string;
  title: string;
  imageUrl: string;
  linkUrl: string | null;
}

interface BannerListProps {
  ui: UIProvider;
  banners: BannerItem[];
}

export function BannerList({ ui, banners }: BannerListProps) {
  const { Card } = ui;
  return (
    <>
      {banners.map((banner) => (
        <Card key={banner.id}>
          <img src={banner.imageUrl} alt={banner.title} />
          {banner.linkUrl ? (
            <a href={banner.linkUrl}>{banner.title}</a>
          ) : (
            <span>{banner.title}</span>
          )}
        </Card>
      ))}
    </>
  );
}
