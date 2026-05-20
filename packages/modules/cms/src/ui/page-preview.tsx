import type { UIProvider } from '@oss/ui-provider-contract';

interface PagePreviewProps {
  ui: UIProvider;
  page: {
    title: string;
    content: unknown;
  };
}

export function PagePreview({ ui, page }: PagePreviewProps) {
  const { Card } = ui;
  return (
    <Card>
      <h1>{page.title}</h1>
      <pre>{JSON.stringify(page.content, null, 2)}</pre>
    </Card>
  );
}
