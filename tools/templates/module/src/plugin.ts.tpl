import { definePlugin } from '@oss/plugin-host';
import { {{Name}}Service } from './service/{{name}}.service.js';
// import { {{name}}Router } from './router/index.js';

export default definePlugin({
  id: '{{name}}',
  // dependsOn: ['identity'], // declare dependencies so the loader boots them first
  register(ctx) {
    ctx.providers.add({{Name}}Service);
    // ctx.routers.add('{{name}}', {{name}}Router);
  },
});
