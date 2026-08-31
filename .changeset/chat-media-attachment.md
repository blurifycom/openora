---
'@openora/core': minor
---

Chat messages can now carry a provider-agnostic media attachment (currently `gif`), validated server-side against an operator-configured host allow-list (`PlatformConfig.chat.allowedAttachmentHosts`, default empty = disabled). `sendRoomMessage`/`sendGlobalMessage` accept either `content`, an `attachment`, or both.
