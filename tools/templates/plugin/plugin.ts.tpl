import { definePlugin } from '@oss/plugin-host';

export default definePlugin({
  id: '{{name}}',
  // dependsOn: ['identity'],
  register(ctx) {
    // ctx.routers.add('{{name}}', {{name}}Router);
    // ctx.providers.add({{Name}}Service);
    // ctx.slots.fill('sidebar-bottom', {{Name}}SidebarItem);
    // ctx.events.on('user:created', handler);
    // ctx.mcp.tool('{{name}}_action', { description: '...', input: schema, handler });
  },
});
