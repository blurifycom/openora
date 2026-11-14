# Introduction

An open-source, headless, plugin-based, AI-native iGaming framework. Clone it, extend it
with your own modules and adapters, and deploy it - without forking core.

The backend ships fully featured out of the box: auth, wallet, lobby, games, chat,
compliance, back office, and CMS. The frontend (all UI) lives in your own consumer
repo and talks to the API over HTTP.

## What makes it different

- **Headless** - backend modules, contracts, and an SDK only. Bring your own UI.
- **Contract-first** - every shape is a Zod schema; types are inferred, never hand-written.
  oRPC turns a schema into a validated route plus OpenAPI.
- **Plugin host** - new functionality enters through typed plugin objects. No forking, no decorator
  magic; every wiring point is an explicit, typed function call.
- **Swappable seams** - payments, KYC, messaging, realtime, and jobs are ports you bind to any
  vendor.
- **AI-native** - a machine-readable contract surface and an MCP dev server let coding agents
  extend the framework safely.

## A taste

A module exposes typed routes; a consumer calls them with a fully typed client - zero codegen:

```ts
import { createClient } from '@openora/core/react';

const client = createClient({ baseUrl: 'http://localhost:3001' });

const { balance, currency } = await client.wallet.getBalance();
await client.wallet.deposit({ amount: 50, currency: 'EUR', provider: 'mock' });
```

## Next

- [Quickstart](../guides/quickstart.md) - run the API and call your first route.
- [Core concepts](./core-concepts.md) - plugins, contracts, services, adapters, events.
- API reference - every route, generated from the live contract, served at `/docs` by a running API (see the Quickstart).
