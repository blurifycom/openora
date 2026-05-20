export type SentryOptions = {
  dsn: string;
  environment: string;
  release?: string;
};

export function initSentry(options: SentryOptions): void {
  process.stdout.write(JSON.stringify({ msg: 'Sentry init stub', ...options }) + '\n');
}
