// RabbitMQ MessageBrokerAdapter. Topic exchange `oss.events`; delivery is at-least-once,
// consumers must be idempotent (use envelope.eventId for dedup). See ADR-0016.
//
// amqplib connect() returns a ChannelModel (not Connection); createChannel/close live on it.
// subscribe() is synchronous; AMQP setup runs in the background - `cancelled` handles the
// race if unsubscribe is called before setup completes.

import type {
  EventEnvelope,
  BrokerHandler,
  MessageBrokerAdapter,
  SubscribeOptions,
} from '@blurifycom/core/contracts';
import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';

type OverlayLogger = {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
};

const EXCHANGE = 'oss.events';

export class RabbitMqBroker implements MessageBrokerAdapter {
  private model: ChannelModel | null = null;
  private channel: Channel | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly activeConsumers = new Set<string>();

  constructor(
    private readonly url: string,
    private readonly logger: OverlayLogger,
  ) {}

  private async ensureConnected(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = (async () => {
      const amqplib = await import('amqplib');
      this.model = await amqplib.connect(this.url);
      this.channel = await this.model.createChannel();
      await this.channel.assertExchange(EXCHANGE, 'topic', { durable: true });
      this.logger.info({ exchange: EXCHANGE }, '[rabbitmq] connected and exchange asserted');
    })();
    return this.connectPromise;
  }

  async publish(envelope: EventEnvelope): Promise<void> {
    await this.ensureConnected();
    const ch = this.channel;
    if (!ch) throw new Error('[rabbitmq] channel not ready');
    const buf = Buffer.from(JSON.stringify(envelope), 'utf8');
    ch.publish(EXCHANGE, envelope.topic, buf, {
      persistent: true,
      contentType: 'application/json',
      messageId: envelope.eventId,
    });
  }

  subscribe(topic: string, handler: BrokerHandler, options?: SubscribeOptions): () => void {
    let cancelled = false;
    let resolvedTag: string | null = null;

    void (async () => {
      try {
        await this.ensureConnected();
        const ch = this.channel;
        if (!ch || cancelled) return;

        const queueName = options?.consumerGroup ?? '';
        const queueOpts = options?.consumerGroup
          ? ({ durable: true, exclusive: false, autoDelete: false } as const)
          : ({ durable: false, exclusive: true, autoDelete: true } as const);

        const { queue } = await ch.assertQueue(queueName, queueOpts);
        await ch.bindQueue(queue, EXCHANGE, topic);

        const { consumerTag } = await ch.consume(queue, (msg: ConsumeMessage | null) => {
          if (!msg || cancelled) return;
          let envelope: EventEnvelope;
          try {
            envelope = JSON.parse(msg.content.toString('utf8')) as EventEnvelope;
          } catch (err) {
            this.logger.error({ topic, err }, '[rabbitmq] failed to parse message - discarding');
            ch.nack(msg, false, false);
            return;
          }
          Promise.resolve(handler(envelope)).then(
            () => ch.ack(msg),
            (err: unknown) => {
              this.logger.error(
                { topic, err },
                '[rabbitmq] handler threw - nacking without requeue',
              );
              ch.nack(msg, false, false);
            },
          );
        });

        resolvedTag = consumerTag;
        this.activeConsumers.add(consumerTag);

        if (cancelled) {
          void ch.cancel(consumerTag);
          this.activeConsumers.delete(consumerTag);
        }
      } catch (err) {
        this.logger.error({ topic, err }, '[rabbitmq] subscribe setup failed');
      }
    })();

    return () => {
      cancelled = true;
      if (resolvedTag) {
        this.activeConsumers.delete(resolvedTag);
        void this.channel?.cancel(resolvedTag);
      }
    };
  }

  async close(): Promise<void> {
    const ch = this.channel;
    if (ch) {
      await Promise.all([...this.activeConsumers].map((tag) => ch.cancel(tag)));
      this.activeConsumers.clear();
      await ch.close();
      this.channel = null;
    }
    if (this.model) {
      await this.model.close();
      this.model = null;
    }
    this.logger.info({}, '[rabbitmq] connection closed');
  }
}
