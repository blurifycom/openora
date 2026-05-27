import { definePlugin } from '@oss/plugin-host';
// import { EVENT_BUS } from '@oss/core';
// import { DRIZZLE } from '@oss/db';
// import { {{Name}}Service } from './service/{{name}}.service.js';
// import { create{{Name}}Router } from './router/index.js';

export default definePlugin({
  id: '{{name}}',
  // dependsOn: ['identity'], // declare dependencies so the loader boots them first
  register(ctx) {
    void ctx;
    // AGENT: implement here. Bind any vendor adapters, then mount the router.
    // The factory resolves deps from the container, so an overlay can rebind an
    // adapter token (last registration wins) without a fork:
    //
    // ctx.provide(SOME_ADAPTER, () => new MockSomeAdapter());
    // ctx.routers.add('{{name}}', (c) =>
    //   create{{Name}}Router(new {{Name}}Service(c.get(DRIZZLE), c.get(EVENT_BUS))),
    // );
  },
});
