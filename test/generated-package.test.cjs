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
  assert.match(generated, /server\.configureEngine\(publicDiscoveryRoot\)/)
  assert.match(generated, /process\.env\.CARS_PUBLIC_DISCOVERY_ROOT === 'true'/)
  assert.doesNotMatch(generated, /process\.env\.SERVER_PRIVATE_KEY/)
  assert.equal(packageJson.dependencies['@bsv/sdk'], '2.4.1')
})

test('only configured compatibility hosts become public discovery roots', () => {
  const { isPublicDiscoveryRoot } = require('../dist/src/public-discovery-root.js')

  assert.equal(isPublicDiscoveryRoot('users.bapp.dev', undefined), true)
  assert.equal(isPublicDiscoveryRoot('https://users.bapp.dev/'), true)
  assert.equal(isPublicDiscoveryRoot('example.com', undefined), false)
  assert.equal(isPublicDiscoveryRoot('root.example', 'root.example,other.example'), true)
})

test('generated platform TLS renews independently from custom domains', () => {
  const { buildProjectIngressTls } = require('../dist/src/ingress-tls.js')
  const projectUuid = '9a52aaaabbbbccccddddeeeeffff0000'
  const generated = buildProjectIngressTls({
    projectUuid,
    frontendEnabled: true,
    backendEnabled: true,
    frontendCustomDomain: 'frontend.example',
    backendCustomDomain: 'backend.example'
  })

  assert.match(
    generated,
    new RegExp(`hosts:\\n      - \\{\\{ \\.Values\\.ingressHostFrontend \\}\\}\\n      - \\{\\{ \\.Values\\.ingressHostBackend \\}\\}\\n      secretName: project-${projectUuid}-tls`)
  )
  assert.match(
    generated,
    new RegExp(`hosts:\\n      - \\{\\{ \\.Values\\.ingressCustomFrontend \\}\\}\\n      secretName: project-${projectUuid}-frontend-custom-tls`)
  )
  assert.match(
    generated,
    new RegExp(`hosts:\\n      - \\{\\{ \\.Values\\.ingressCustomBackend \\}\\}\\n      secretName: project-${projectUuid}-backend-custom-tls`)
  )
})

test('a shared frontend and backend custom domain uses one certificate', () => {
  const { buildProjectIngressTls } = require('../dist/src/ingress-tls.js')
  const projectUuid = '9a52aaaabbbbccccddddeeeeffff0000'
  const generated = buildProjectIngressTls({
    projectUuid,
    frontendEnabled: true,
    backendEnabled: true,
    frontendCustomDomain: 'shared.example',
    backendCustomDomain: 'shared.example'
  })

  assert.match(generated, new RegExp(`secretName: project-${projectUuid}-custom-tls`))
  assert.equal((generated.match(/ingressCustom/g) || []).length, 1)
  assert.doesNotMatch(generated, /frontend-custom-tls|backend-custom-tls/)
})

test('projects without custom domains retain the existing platform secret', () => {
  const { buildProjectIngressTls } = require('../dist/src/ingress-tls.js')
  const projectUuid = '9a52aaaabbbbccccddddeeeeffff0000'
  const generated = buildProjectIngressTls({
    projectUuid,
    frontendEnabled: true,
    backendEnabled: false
  })

  assert.match(generated, new RegExp(`secretName: project-${projectUuid}-tls`))
  assert.doesNotMatch(generated, /custom-tls|ingressCustom/)
  assert.throws(
    () => buildProjectIngressTls({ projectUuid, frontendEnabled: false, backendEnabled: false }),
    /at least one generated platform host/
  )
})

test('database migrations resolve beside the executing source or compiled module', () => {
  const dbSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'db.ts'),
    'utf8'
  )

  assert.match(dbSource, /process\.env\.CARS_MIGRATIONS_DIR \|\| join\(__dirname, 'migrations'\)/)
  assert.doesNotMatch(dbSource, /directory: '\.\/src\/migrations'/)
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
  const publicRootScript = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'k8s', 'reconcile-users-public-discovery-root.sh'),
    'utf8'
  )
  const evictionScript = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'k8s', 'evict-denied-discovery-records.sh'),
    'utf8'
  )

  assert.match(dockerfile, /buildah\/stable:v1\.43\.2@sha256:[0-9a-f]{64}/)
  assert.match(dockerfile, /ARG NODE_VERSION=24\.19\.0/)
  assert.match(dockerfile, /ARG KUBECTL_VERSION=1\.34\.11/)
  assert.match(dockerfile, /ARG HELM_VERSION=4\.2\.4/)
  assert.equal((dockerfile.match(/sha256sum --check --strict/g) || []).length, 3)
  assert.match(dockerfile, /FROM \$\{BUILDAH_IMAGE\} AS tools/)
  assert.match(dockerfile, /FROM \$\{BUILDAH_IMAGE\} AS build/)
  assert.match(dockerfile, /FROM \$\{BUILDAH_IMAGE\} AS runtime/)
  assert.match(dockerfile, /npm prune --omit=dev/)
  assert.match(dockerfile, /COPY --from=tools \/usr\/local\/bin\/node \/usr\/local\/bin\/node/)
  assert.match(dockerfile, /test ! -e \/usr\/local\/bin\/npm/)
  assert.match(dockerfile, /ENV CARS_MIGRATIONS_DIR=\/app\/src\/migrations/)
  assert.match(dockerfile, /\/app\/src\/migrations\/\$\(basename "\$\{file%\.js\}"\)\.ts/)
  assert.match(dockerfile, /AS build[\s\S]+dnf install -y gcc-c\+\+ make[\s\S]+COPY --from=tools \/usr\/local\/ \/usr\/local\//)
  assert.match(dockerfile, /AS runtime[\s\S]+dnf install -y bash ca-certificates openssl shadow-utils[\s\S]+ARG APP_COMMIT/)
  assert.doesNotMatch(dockerfile, /setup_lts|get-helm-3|VERIFY_CHECKSUM=false|:latest/)

  assert.doesNotMatch(workflow, /\n  push:/)
  assert.match(workflow, /required: true/)
  assert.match(workflow, /git merge-base --is-ancestor/)
  assert.match(deployScript, /deployment\/cars --timeout=15m[\s\S]+deployment\/cars-advertisement-controller --timeout=15m/)
  assert.match(
    deployScript,
    /CARS_DISCOVERY_SKIP_PUBLIC_POSTFLIGHT=true[\s\S]+reconcile-users-public-discovery-root\.sh enable[\s\S]+evict-denied-discovery-records\.sh[\s\S]+reconcile-users-public-discovery-root\.sh enable/
  )
  assert.match(deployScript, /rollout lost node diversity/)
  assert.match(deployScript, /metadata\.deletionTimestamp.*spec\.containers\[0\]\.image.*status\.containerStatuses\[0\]\.ready/)
  assert.doesNotMatch(deployScript, /node -[ep]/)
  assert.match(publicRootScript, /cars-project-c6a84fc53bb50c34e179dcd861eb3964/)
  assert.match(publicRootScript, /tm_users[\s\S]+tm_ship[\s\S]+tm_slap/)
  assert.match(publicRootScript, /ls_users[\s\S]+ls_ship[\s\S]+ls_slap/)
  assert.match(publicRootScript, /tm_kvstore/)
  assert.match(publicRootScript, /ls_kvstore/)
  assert.match(publicRootScript, /filterDiscoveryLookupPayload/)
  assert.match(publicRootScript, /expected one live, deduplicated KVStore provider/)
  assert.match(publicRootScript, /HTTPSOverlayLookupFacilitator/)
  assert.match(publicRootScript, /exec -i deployment\/cars -c cars -- node/)
  assert.match(publicRootScript, /CARS_BANNED_AD_CAPABILITIES/)
  assert.match(evictionScript, /networkOpsDiscoveryEvictions/)
  assert.match(evictionScript, /operator-capability-denylist/)
  assert.match(evictionScript, /users\.bapp\.dev/)
  assert.match(evictionScript, /semantic-provider-capability-duplicate/)
  assert.match(deployScript, /evict-denied-discovery-records\.sh/)
  assert.doesNotMatch(
    fs.readFileSync(path.join(__dirname, '..', 'scripts', 'k8s', 'build-local-image.sh'), 'utf8'),
    /node -[ep]/
  )

  const advertisementManifest = fs.readFileSync(
    path.join(__dirname, '..', 'k8s', 'advertisement-controller.yaml'),
    'utf8'
  )
  assert.match(advertisementManifest, /topologySpreadConstraints:/)
  assert.match(advertisementManifest, /minDomains: 2/)
  assert.match(advertisementManifest, /whenUnsatisfiable: DoNotSchedule/)
  assert.match(advertisementManifest, /matchLabelKeys:\n\s+- pod-template-hash/)
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
  assert.match(requestLogger, /filterDiscoveryLookupPayload/)
  assert.match(requestLogger, /probeDiscoveryCapability/)
  assert.match(requestLogger, /X-CARS-Discovery-Filtered/)
  assert.match(requestLogger, /CARS_DISCOVERY_DENYLIST_STORAGE/)
  assert.match(requestLogger, /CARS_BANNED_AD_CAPABILITIES/)
  assert.match(requestLogger, /isDeniedDiscoveryCapability/)
  assert.match(requestLogger, /Discovery probes require a public hostname/)
  assert.match(requestLogger, /isPublicProbeAddress/)
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
