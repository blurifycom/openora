{
  "name": "@{{name}}/api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "node --import tsx --watch --env-file-if-exists=../../.env src/main.ts",
    "start": "node --import tsx --env-file-if-exists=../../.env src/main.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@blurifycom/api-runtime": "link:{{ossFromApp}}/packages/platform/api-runtime",
    "@blurifycom/orpc-contract": "link:{{ossFromApp}}/packages/contracts/orpc-contract",
    "@blurifycom/plugin-host": "link:{{ossFromApp}}/packages/platform/plugin-host",
    "@blurifycom/shared-schemas": "link:{{ossFromApp}}/packages/contracts/shared-schemas",
    "@blurifycom/adapters": "link:{{ossFromApp}}/packages/contracts/adapters",
    "@blurifycom/modules": "link:{{ossFromApp}}/packages/modules"
  },
  "devDependencies": {
    "@blurifycom/tsconfig": "link:{{ossFromApp}}/packages/config/tsconfig",
    "tsx": "4.22.2",
    "typescript": "6.0.3"
  }
}
