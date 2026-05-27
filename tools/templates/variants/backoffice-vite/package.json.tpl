{
  "name": "@{{name}}/backoffice",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "dev": "vite dev --port 3002",
    "preview": "vite preview --port 3002",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@oss/react-sdk": "link:{{ossFromApp}}/packages/sdks/react-sdk",
    "@oss/ui-provider-contract": "link:{{ossFromApp}}/packages/ui/provider-contract",
    "@oss/ui-provider-daisyui": "link:{{ossFromApp}}/packages/ui/provider-daisyui",
    "@tanstack/react-query": "5.100.11",
    "@tanstack/react-query-devtools": "5.100.11",
    "@tanstack/react-router": "1.135.6",
    "react": "19.2.6",
    "react-dom": "19.2.6",
    "vite": "7.1.12"
  },
  "devDependencies": {
    "@oss/tsconfig": "link:{{ossFromApp}}/packages/config/tsconfig",
    "@tailwindcss/vite": "4.3.0",
    "@tanstack/router-plugin": "1.135.6",
    "@types/react": "19.2.14",
    "@types/react-dom": "19.2.3",
    "@vitejs/plugin-react": "5.0.5",
    "daisyui": "5.5.20",
    "tailwindcss": "4.3.0",
    "typescript": "6.0.3"
  }
}
