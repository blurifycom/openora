// Frontend (React) entry for the engagement domain - the `@oss/engagement/react`
// subpath. Domain-owned hooks live here (not in the base @oss/core/react SDK), so the
// SDK stays domain-agnostic and a consumer pulls a domain's hooks only when it
// imports this subpath. react / react-query are peer dependencies.
export {
  useChatStream,
  type ChatMessage,
  type UseChatStreamOptions,
  type UseChatStreamResult,
} from './chat/react/use-chat-stream.js';
