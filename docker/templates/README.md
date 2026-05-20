# Consumer Docker templates

Templates a downstream consumer of casino-oss (eg Consumer) copies into their
own repo to ship a Dockerized stack. The OSS itself runs from
`casino-oss/docker/oss-reference.docker-compose.yml`; consumers do **not** use
that file - they bring their own thin compose using these templates.

## Files

| Template             | Drop it at                            | Purpose                                               |
| -------------------- | ------------------------------------- | ----------------------------------------------------- |
| `Dockerfile.api`     | `<consumer>/docker/Dockerfile.api`    | Builds the consumer API image (Nest + oRPC + plugins) |
| `Dockerfile.web`     | `<consumer>/docker/Dockerfile.web`    | Builds the consumer Next.js image (optional)          |
| `docker-compose.yml` | `<consumer>/infra/docker-compose.yml` | Wires services + api + web                            |

## Layout assumed

```
<workspace>/
├── casino-oss/            # the OSS, vendored as a sibling clone (until @oss/* are on npm)
└── <consumer>/            # your repo
    ├── apps/
    │   ├── api/           # 18-line createApp() entrypoint
    │   └── web/           # optional Next.js consumer
    ├── plugins/           # consumer-specific plugins
    ├── extensions.config.ts
    ├── docker/
    │   ├── Dockerfile.api
    │   └── Dockerfile.web
    └── infra/
        └── docker-compose.yml
```

All three files reference `casino-oss/...` as a sibling, so the Docker build
context must be the parent directory containing both. The provided
`docker-compose.yml` sets `context: ../..` to satisfy this.

## When OSS goes on npm

Once `@oss/*` is published to a registry, the consumer no longer needs the
sibling `casino-oss/` clone:

1. Drop the `link:../casino-oss/...` overrides from your `package.json` and pin
   versions like `"@oss/api-runtime": "^1.0.0"` in your `dependencies`.
2. Simplify `Dockerfile.api` to skip stage 1 (no more `COPY casino-oss/...`)
   and just `pnpm install` from the npm registry.
3. Change the compose `context:` back to your repo root.

The Dockerfiles below are commented so you can see what becomes obsolete.

## How to copy the template

```bash
cp -r casino-oss/docker/templates/. <consumer>/
# then edit Dockerfile.api, Dockerfile.web, infra/docker-compose.yml to fit
# your service names, ports, and any extra build steps.
```

## Customizations to expect

- Container names + project name (`name:` field in compose)
- Port mapping (avoid colliding with the OSS reference stack)
- Extra env vars your plugins need
- Volume mounts for static assets if your web app serves any
- Build args if you fork the @oss tag pinned in `pnpm.overrides`
