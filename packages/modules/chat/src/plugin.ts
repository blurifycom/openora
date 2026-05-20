import { definePlugin } from '@oss/plugin-host';
import { ChatService } from './service/chat.service.js';
import { ChatController } from './router/index.js';

export default definePlugin({
  id: 'chat',
  register(ctx) {
    ctx.providers.add(ChatService);
    ctx.controllers.add(ChatController);
  },
});
