export type PubSubHandler = (message: unknown) => void | Promise<void>;

export type PubSubPort = {
  publish(channel: string, message: unknown): Promise<void>;
  subscribe(channel: string, handler: PubSubHandler): void;
  unsubscribe(channel: string): void;
};
