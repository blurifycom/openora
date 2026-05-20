import { Injectable } from '@nestjs/common';

@Injectable()
export class RouterRegistry {
  private readonly routers = new Map<string, unknown>();

  register(namespace: string, router: unknown): void {
    if (this.routers.has(namespace)) {
      throw new Error(`Router namespace "${namespace}" is already registered`);
    }
    this.routers.set(namespace, router);
  }

  getAll(): Map<string, unknown> {
    return new Map(this.routers);
  }

  get(namespace: string): unknown | undefined {
    return this.routers.get(namespace);
  }
}
