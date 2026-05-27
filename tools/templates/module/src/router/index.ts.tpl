import { implement } from '@orpc/server';
import { type OssContext } from '@oss/core';
import { {{Name}}Service } from '../service/{{name}}.service.js';

// oRPC router factory for {{Name}}. The plugin builds the service from the
// container and passes it here; each procedure delegates to the service.
//
// AGENT: implement here - swap the placeholder contract for your module's
// contract (import from '@oss/orpc-contract/{{name}}' or a local schemas/).
//
// export function create{{Name}}Router({{name}}: {{Name}}Service) {
//   const os = implement({{name}}Contract).$context<OssContext>();
//   return os.router({
//     list: os.list.handler(({ input }) => {{name}}.list(input)),
//   });
// }
