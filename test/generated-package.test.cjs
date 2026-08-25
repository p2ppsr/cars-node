const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

test('generated overlays pin the TTN-compatible Overlay Express release', () => {
  const compiled = fs.readFileSync(
    path.join(__dirname, '..', 'dist', 'src', 'utils.js'),
    'utf8'
  )

  assert.match(compiled, /"@bsv\/overlay-express": "2\.6\.0"/)
  assert.doesNotMatch(compiled, /"@bsv\/overlay-express": "2\.5\.1"/)
})

test('generated overlays configure TTN Arcade and ChainTracks without ARC fallback', () => {
  const { generateIndexTs } = require('../dist/src/utils.js')
  const generated = generateIndexTs({ schema: 'bsv-app', schemaVersion: '1.0' })

  assert.match(generated, /server\.configureNetwork\(network\)/)
  assert.match(generated, /server\.configureArcade\(arcadeUrl/)
  assert.match(generated, /server\.configureChaintracks\(chaintracksUrl/)
  assert.match(generated, /network !== 'ttn' && process\.env\.ARC_API_KEY/)
  assert.match(generated, /https:\/\/arcade-v2-ttn-us-1\.bsvblockchain\.tech/)
})

test('generated project backends are thin advertisement consumers', () => {
  const { generateIndexTs, generatePackageJson } = require('../dist/src/utils.js')
  const generated = generateIndexTs({ schema: 'bsv-app', schemaVersion: '1.0' })
  const packageJson = generatePackageJson({})

  assert.match(generated, /crypto\.randomBytes\(32\)/)
  assert.match(generated, /advertiser: passiveAdvertiser/)
  assert.match(generated, /server\.configureEngine\(false\)/)
  assert.doesNotMatch(generated, /process\.env\.SERVER_PRIVATE_KEY/)
  assert.equal(packageJson.dependencies['@bsv/sdk'], '2.4.0')
})

test('control-plane image and deploy path pin and verify the production supply chain', () => {
  const dockerfile = fs.readFileSync(
    path.join(__dirname, '..', 'Dockerfile'),
    'utf8'
  )
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'deploy-production-local.yml'),
    'utf8'
  )
  const deployScript = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'k8s', 'deploy-local.sh'),
    'utf8'
  )

  assert.match(dockerfile, /buildah\/stable:v1\.43\.2@sha256:[0-9a-f]{64}/)
  assert.match(dockerfile, /ARG NODE_VERSION=24\.19\.0/)
  assert.match(dockerfile, /ARG KUBECTL_VERSION=1\.34\.9/)
  assert.match(dockerfile, /ARG HELM_VERSION=3\.21\.4/)
  assert.equal((dockerfile.match(/sha256sum --check --strict/g) || []).length, 3)
  assert.match(dockerfile, /FROM \$\{BUILDAH_IMAGE\} AS tools/)
  assert.match(dockerfile, /FROM \$\{BUILDAH_IMAGE\} AS build/)
  assert.match(dockerfile, /FROM \$\{BUILDAH_IMAGE\} AS runtime/)
  assert.match(dockerfile, /npm prune --omit=dev/)
  assert.doesNotMatch(dockerfile, /setup_lts|get-helm-3|VERIFY_CHECKSUM=false|:latest/)

  assert.doesNotMatch(workflow, /\n  push:/)
  assert.match(workflow, /required: true/)
  assert.match(workflow, /git merge-base --is-ancestor/)
  assert.match(deployScript, /deployment\/cars --timeout=15m[\s\S]+deployment\/cars-advertisement-controller --timeout=15m/)
})

test('legacy index shim disables local discovery services and advertisement writes', () => {
  const {
    generateCentralizedAdvertisementsIndexTs,
    generateSafeAccessLoggerCjs
  } = require('../dist/src/utils.js')
  const legacyIndex = `import OverlayExpress from '@bsv/overlay-express'\nconst main = async () => {\n  await server.configureEngine();\n  await server.start();\n}`
  const thinIndex = generateCentralizedAdvertisementsIndexTs(legacyIndex)
  const requestLogger = generateSafeAccessLoggerCjs()

  assert.match(thinIndex, /server\.configureEngine\(false\)/)
  assert.match(thinIndex, /server\.engine\.syncAdvertisements = async/)
  assert.match(thinIndex, /advertiser: carsNodePassiveAdvertiser/)
  assert.match(thinIndex, /CARSNodePushDrop/)
  assert.match(requestLogger, /CARS_CENTRALIZED_ADVERTISEMENTS/)
  assert.match(requestLogger, /randomBytes\(32\)/)
  assert.doesNotMatch(requestLogger, /overlay-express/)
  assert.equal(generateCentralizedAdvertisementsIndexTs(thinIndex), thinIndex)
})

test('shared MySQL pins the proven HAProxy backend failover policy', () => {
  const manifest = fs.readFileSync(
    path.join(__dirname, '..', 'k8s', 'shared-databases.yaml'),
    'utf8'
  )

  assert.match(manifest, /name: shared-mysql-env-vars-haproxy/)
  assert.match(manifest, /envVarsSecret: shared-mysql-env-vars-haproxy/)
  assert.match(manifest, /HA_SERVER_OPTIONS: "resolvers kubernetes check inter 1000 rise 1 fall 2 weight 1 on-marked-down shutdown-sessions"/)
  assert.match(manifest, /HA_CONNECTION_TIMEOUT: "2"/)
  assert.match(
    manifest,
    /percona\/percona-xtradb-cluster:8\.4\.10-10\.1@sha256:c4c9f39ce0b4cff7bccc2c138c08ed60e78deb8539d0e1e3a51fbb2ce3db7875/
  )
  const uploadRoute = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'upload.ts'),
    'utf8'
  )
  assert.match(
    uploadRoute,
    /percona\/percona-xtradb-cluster:8\.4\.10-10\.1@sha256:c4c9f39ce0b4cff7bccc2c138c08ed60e78deb8539d0e1e3a51fbb2ce3db7875/
  )
})
