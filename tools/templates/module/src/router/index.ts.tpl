import { os } from '@orpc/server';
import { {{Name}}Service } from '../service/{{name}}.service.js';

// oRPC contract + handlers for {{Name}}.
// Each procedure: define input/output Zod schemas (from ../schemas), delegate to the service.
//
// AGENT: implement here - replace the commented stub with the real router.
//
// export const {{name}}Router = os
//   .$context<{ {{name}}Service: {{Name}}Service }>()
//   .router({
//     list: os
//       .input(ListInputSchema)
//       .output(ListOutputSchema)
//       .handler(({ input, context }) => context.{{name}}Service.list(input)),
//   });
