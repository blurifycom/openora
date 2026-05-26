import { oc } from '@orpc/contract';
import { z } from 'zod';

// TODO: move shared schemas to packages/contracts/domain-schemas if reused across modules.

const {{Name}}Schema = z.object({
  id: z.string(),
});

export type {{Name}} = z.infer<typeof {{Name}}Schema>;

export const {{name}}Contract = {
  get{{Name}}: oc
    .route({ method: 'GET', path: '/{{name}}/:id' })
    .input(z.object({ id: z.string() }))
    .output({{Name}}Schema),
};
