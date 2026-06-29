packages:
  - 'apps/*'

# pnpm 10+ reads overrides here, NOT from package.json's "pnpm.overrides" (ignored).
# Pins every @blurifycom/* import - including transitive ones - to the linked checkout.
overrides:
  '@blurifycom/core': 'link:{{ossFromRoot}}/packages/core'

allowBuilds:
  esbuild: true
  msgpackr-extract: true
  sharp: true
  tldjs: false
