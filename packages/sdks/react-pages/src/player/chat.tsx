'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useOrpcClient, useChatStream, useUI, type ChatMessage } from '@oss/react-hooks';

export type PlayerChatPageProps = {
  /** Room to view. Omit (or null) for the global channel. */
  roomId?: string | null;
};

// Player community chat. Backfills with `chat.getGlobalMessages`, then streams
// live messages from `chat.streamMessages` over SSE (the generic useChatStream
// transport, backed by REALTIME_TRANSPORT - first-party in-process by default,
// swappable to a managed vendor). Sends via `chat.sendGlobalMessage`; the sent
// message arrives back over the stream (deduped by id), so we don't append it
// manually. See ADR-0007.
export function PlayerChatPage({ roomId = null }: PlayerChatPageProps = {}) {
  const client = useOrpcClient();
  const { Card, Button, Input, Badge } = useUI();
  const [draft, setDraft] = useState('');

  const { data: backfill } = useQuery({
    queryKey: ['chat', 'global'],
    queryFn: () => client.chat.getGlobalMessages(),
  });

  const { messages, status, setMessages } = useChatStream(roomId);

  // Seed the list once the backfill resolves, keeping any live messages that
  // already arrived (dedupe by id).
  useEffect(() => {
    if (!backfill) return;
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m.id));
      const merged = [...backfill.filter((m) => !seen.has(m.id)), ...prev];
      return merged;
    });
    // setMessages is stable; only re-run when the backfill changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backfill]);

  const send = useMutation({
    mutationFn: (content: string) => client.chat.sendGlobalMessage({ content }),
    onSuccess: () => setDraft(''),
  });

  const onSubmit = (): void => {
    const content = draft.trim();
    if (content.length === 0) return;
    send.mutate(content);
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-header__title">Chat</h1>
          <div className="page-header__hint">
            Global community chat. Messages stream live over SSE (<code>chat.streamMessages</code>).
          </div>
        </div>
        <Badge
          variant={status === 'open' ? 'success' : status === 'connecting' ? 'warning' : 'outline'}
        >
          {status === 'open' ? 'Live' : status}
        </Badge>
      </div>

      <section className="player-section">
        <Card className="player-card">
          <div className="player-card__body">
            {messages.length === 0 ? (
              <p className="muted">No messages yet. Say hello.</p>
            ) : (
              <ul className="chat-messages">
                {messages.map((m: ChatMessage) => (
                  <li key={m.id} className="chat-messages__item">
                    <span className="chat-messages__author">{m.username}</span>
                    <span className="chat-messages__text">{m.content}</span>
                    <span className="muted chat-messages__time">
                      {new Date(m.createdAt).toLocaleTimeString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </section>

      <section className="player-section">
        <Card className="player-card">
          <div className="player-card__body chat-composer">
            <Input
              label="Message"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onSubmit();
              }}
              placeholder="Type a message and press Enter"
            />
            <Button loading={send.isPending} disabled={draft.trim().length === 0} onClick={onSubmit}>
              Send
            </Button>
          </div>
        </Card>
      </section>
    </>
  );
}
