export type OutboxEvent = {
  id: string;
  type: string;
  payload: unknown;
  tenantId: string;
  createdAt: Date;
  processedAt?: Date;
};

export type OutboxPort = {
  append(event: Omit<OutboxEvent, 'id' | 'createdAt'>): Promise<void>;
  listPending(limit: number): Promise<OutboxEvent[]>;
  markProcessed(id: string): Promise<void>;
};
