import { existsSync, writeFileSync } from 'node:fs';
import { generateFiles } from 'fumadocs-openapi';
import { openapi } from '../lib/openapi';

const output = './content/docs/api';

async function main(): Promise<void> {
  if (!existsSync('./openapi.json')) {
    console.warn(
      '[generate-openapi] openapi.json missing - run `pnpm codegen` first. Skipping API reference.',
    );
    return;
  }

  await generateFiles({
    input: openapi,
    output,
    includeDescription: true,
  });

  writeFileSync(
    `${output}/meta.json`,
    `${JSON.stringify({ title: 'API reference', pages: ['...'] }, null, 2)}\n`,
  );
}

void main();
