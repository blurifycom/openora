import { definePlugin } from '@oss/plugin-host';

export default definePlugin({
  id: '{{name}}',
  // dependsOn: ['identity'],
  register(ctx) {
    void ctx;
    // ctx.provide(SOME_ADAPTER, () => new MyAdapter());
    // ctx.routers.add('{{name}}', (c) => create{{Name}}Router(c.get(SOME_ADAPTER)));
    // ctx.slots.fill('sidebar-bottom', {{Name}}SidebarItem);
    // ctx.events.on('user:created', handler);
    // ctx.mcp.tool('{{name}}_action', { description: '...', input: schema, handler });
  },
});
