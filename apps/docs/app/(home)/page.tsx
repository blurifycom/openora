import Link from 'next/link';
import { appName } from '@/lib/shared';

export default function HomePage() {
  return (
    <div className="flex flex-col justify-center text-center flex-1 gap-4">
      <h1 className="text-2xl font-bold">{appName}</h1>
      <p className="text-fd-muted-foreground">
        Open-source, headless, plugin-based, AI-native igaming platform.
      </p>
      <p>
        <Link href="/docs" className="font-medium underline">
          Read the documentation
        </Link>
      </p>
    </div>
  );
}
