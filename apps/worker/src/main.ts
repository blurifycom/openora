import { Worker } from 'bullmq';

const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const redisHost = new URL(redisUrl).hostname;
const redisPort = Number(new URL(redisUrl).port || 6379);

const connection = { host: redisHost, port: redisPort };

const defaultWorker = new Worker(
  'default',
  async (job) => {
    process.stdout.write(
      JSON.stringify({ msg: 'processing job', id: job.id, name: job.name }) + '\n',
    );
  },
  { connection },
);

defaultWorker.on('completed', (job) => {
  process.stdout.write(JSON.stringify({ msg: 'job completed', id: job.id }) + '\n');
});

defaultWorker.on('failed', (job, err) => {
  process.stderr.write(
    JSON.stringify({ msg: 'job failed', id: job?.id, error: err.message }) + '\n',
  );
});

process.stdout.write(`Worker started - connected to ${redisHost}:${redisPort}\n`);

process.on('SIGTERM', async () => {
  await defaultWorker.close();
  process.exit(0);
});
