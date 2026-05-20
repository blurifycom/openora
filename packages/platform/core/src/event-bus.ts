import { Injectable } from '@nestjs/common';

export type EventHandler<T = unknown> = (payload: T) => void | Promise<void>;

export type EventBus = {
  emit(event: string, payload: unknown): void;
  on(event: string, handler: EventHandler): void;
};

export const EVENT_BUS = Symbol('EVENT_BUS');

@Injectable()
export class InMemoryEventBus implements EventBus {
  private handlers = new Map<string, EventHandler[]>();

  emit(event: string, payload: unknown): void {
    const fns = this.handlers.get(event) ?? [];
    for (const fn of fns) {
      void fn(payload);
    }
  }

  on(event: string, handler: EventHandler): void {
    const fns = this.handlers.get(event) ?? [];
    this.handlers.set(event, [...fns, handler]);
  }
}
