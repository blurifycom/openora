packages:
  - 'apps/*'

allowBuilds:
  esbuild: true
  msgpackr-extract: true
  sharp: true
  tldjs: false

# Supply-chain cooldown: install refuses a version younger than a day. Openora releases are exempt
# so a project can take a new framework version the day it ships.
minimumReleaseAge: 1440
minimumReleaseAgeExclude:
  - '@openora/*'
