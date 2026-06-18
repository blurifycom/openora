import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { EventEnvelope } from '@oss/core/contracts';

const channel = {
  assertExchange: vi.fn().mockResolvedValue({}),
  assertQueue: vi.fn().mockResolvedValue({ queue: 'q1' }),
  bindQueue: vi.fn().mockResolvedValue({}),
  consume: vi.fn().mockResolvedValue({ consumerTag: 'tag1' }),
  cancel: vi.fn().mockResolvedValue({}),
  publish: vi.fn().mockReturnValue(true),
  ack: vi.fn(),
  nack: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
};
const model = {
  createChannel: vi.fn().mockResolvedValue(channel),
  close: vi.fn().mockResolvedValue(undefined),
};
const connect = vi.fn().mockResolvedValue(model);

vi.mock('amqplib', () => ({ connect: (...args: unknown[]) => connect(...args) }));

const log = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };

const envelope: EventEnvelope = {
  eventId: 'e1',
  topic: 'wallet.deposit.completed',
  payload: { userId: 'u1' },
  occurredAt: '2026-06-09T00:00:00.000Z',
  schemaVersion: 1,
};

describe('RabbitMqBroker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connect.mockResolvedValue(model);
    model.createChannel.mockResolvedValue(channel);
  });

  it('connects lazily and publishes the serialized envelope to the topic exchange', async () => {
    const { RabbitMqBroker } = await import('../rabbitmq-broker.js');
    const broker = new RabbitMqBroker('amqp://localhost', log);

    await broker.publish(envelope);

    expect(connect).toHaveBeenCalledOnce();
    expect(channel.assertExchange).toHaveBeenCalledWith('oss.events', 'topic', { durable: true });
    const [exchange, routingKey, content] = channel.publish.mock.calls[0]!;
    expect(exchange).toBe('oss.events');
    expect(routingKey).toBe('wallet.deposit.completed');
    expect(JSON.parse((content as Buffer).toString('utf8'))).toEqual(envelope);
  });

  it('closes the channel and connection', async () => {
    const { RabbitMqBroker } = await import('../rabbitmq-broker.js');
    const broker = new RabbitMqBroker('amqp://localhost', log);
    await broker.publish(envelope);
    await broker.close();
    expect(channel.close).toHaveBeenCalledOnce();
    expect(model.close).toHaveBeenCalledOnce();
  });
});
