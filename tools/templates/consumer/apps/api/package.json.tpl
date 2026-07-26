{
  "name": "@{{name}}/api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "node --import tsx --watch --env-file-if-exists=../../.env src/main.ts",
    "start": "node --import tsx --env-file-if-exists=../../.env src/main.ts",
    "db:seed": "node --import tsx --env-file-if-exists=../../.env src/seed.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@openora/core": "{{coreVersion}}"
  },
  "devDependencies": {
    "tsx": "4.22.2",
    "typescript": "6.0.3"
  }
}
