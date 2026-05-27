{
  "name": "@{{name}}/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "next build",
    "dev": "next dev --port 3000",
    "start": "next start --port 3000",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@oss/react-sdk": "link:{{ossFromApp}}/packages/sdks/react-sdk",
    "@oss/ui-provider-contract": "link:{{ossFromApp}}/packages/ui/provider-contract",
    "@oss/ui-provider-daisyui": "link:{{ossFromApp}}/packages/ui/provider-daisyui",
    "@tanstack/react-query": "5.100.11",
    "next": "16.2.6",
    "react": "19.2.6",
    "react-dom": "19.2.6"
  },
  "devDependencies": {
    "@oss/tsconfig": "link:{{ossFromApp}}/packages/config/tsconfig",
    "@tailwindcss/postcss": "4.3.0",
    "@types/react": "19.2.14",
    "@types/react-dom": "19.2.3",
    "daisyui": "5.5.20",
    "tailwindcss": "4.3.0",
    "typescript": "6.0.3"
  }
}
