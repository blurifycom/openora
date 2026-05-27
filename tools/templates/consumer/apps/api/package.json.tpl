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
    "@oss/api-runtime": "link:{{ossFromApp}}/packages/platform/api-runtime",
    "@oss/orpc-contract": "link:{{ossFromApp}}/packages/contracts/orpc-contract",
    "@oss/plugin-host": "link:{{ossFromApp}}/packages/platform/plugin-host",
    "@oss/shared-schemas": "link:{{ossFromApp}}/packages/contracts/shared-schemas",
    "@oss/adapters": "link:{{ossFromApp}}/packages/contracts/adapters",
    "@oss/modules": "link:{{ossFromApp}}/packages/modules"
  },
  "devDependencies": {
    "@oss/tsconfig": "link:{{ossFromApp}}/packages/config/tsconfig",
    "tsx": "4.22.2",
    "typescript": "6.0.3"
  }
}
