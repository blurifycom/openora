{
  "name": "@oss/module-{{name}}",
  "version": "0.0.1",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./plugin": "./src/plugin.ts"
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test:unit": "vitest run --reporter=verbose",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@oss/contracts": "workspace:*",
    "@oss/core": "workspace:*"
  },
  "devDependencies": {
    "@oss/tsconfig": "workspace:*",
    "@oss/vitest-config": "workspace:*",
    "typescript": "6.0.3"
  }
}
