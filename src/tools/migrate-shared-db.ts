import { spawnSync } from 'child_process';
import {
  buildProjectDbCredentials,
  ensureSharedProjectDatabases,
  getSharedDbConfig,
  ProjectDbCredentials,
} from '../shared-db';

interface Args {
  all: boolean;
  namespace?: string;
  dryRun: boolean;
  apply: boolean;
  prune: boolean;
  carsMetadata: boolean;
  sourceUrl?: string;
  targetUrl?: string;
}

interface Discovery {
  namespace: string;
  projectId: string;
  releaseName?: string;
  appDeployment?: string;
  appReplicas: number;
  secretName?: string;
  knexUrl?: string;
  mongoUrl?: string;
  dbResources: string[];
  status: 'ready' | 'already-shared' | 'missing-secret' | 'missing-source-db' | 'manual-review';
  reason?: string;
}

main().catch(error => {
  console.error(error?.message || error);
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dryRun && !args.apply && !args.prune) {
    args.dryRun = true;
  }

  if (args.carsMetadata) {
    migrateCarsMetadata(args);
    return;
  }

  const namespaces = args.all ? listProjectNamespaces() : [required(args.namespace, '--namespace is required unless --all is set')];
  const discoveries = namespaces.map(discoverNamespace);
  console.log(JSON.stringify({
    mode: args.dryRun ? 'dry-run' : args.prune ? 'prune' : 'apply',
    projects: discoveries.map(redactDiscoveryForOutput),
  }, null, 2));

  if (args.dryRun) {
    return;
  }

  if (args.prune) {
    for (const discovery of discoveries) {
      pruneNamespace(discovery);
    }
    return;
  }

  for (const discovery of discoveries) {
    if (discovery.status === 'already-shared') {
      console.log(`${discovery.namespace}: already shared`);
      continue;
    }
    if (discovery.status !== 'ready') {
      throw new Error(`${discovery.namespace}: cannot apply migration while status=${discovery.status} (${discovery.reason || 'no reason'})`);
    }
    await applyProjectMigration(discovery);
  }
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    all: false,
    dryRun: false,
    apply: false,
    prune: false,
    carsMetadata: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--all':
        args.all = true;
        break;
      case '--namespace':
        args.namespace = argv[++i];
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--apply':
        args.apply = true;
        break;
      case '--prune':
        args.prune = true;
        break;
      case '--cars-metadata':
        args.carsMetadata = true;
        break;
      case '--source-url':
        args.sourceUrl = argv[++i];
        break;
      case '--target-url':
        args.targetUrl = argv[++i];
        break;
      case '--help':
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if ([args.dryRun, args.apply, args.prune].filter(Boolean).length > 1) {
    throw new Error('Choose only one of --dry-run, --apply, or --prune');
  }
  return args;
}

function printUsage() {
  console.log(`usage:
  npm run migrate:shared-db -- --all --dry-run
  npm run migrate:shared-db -- --namespace cars-project-... --apply
  npm run migrate:shared-db -- --namespace cars-project-... --prune
  npm run migrate:shared-db -- --cars-metadata --source-url mysql://... --target-url mysql://... --apply`);
}

function listProjectNamespaces(): string[] {
  const doc = kubectlJson(['get', 'namespace', '-o', 'json']);
  return (doc.items || [])
    .map((item: any) => item.metadata?.name)
    .filter((name: string) => /^cars-project-[a-f0-9]{32}$/.test(name))
    .sort();
}

function discoverNamespace(namespace: string): Discovery {
  const projectId = namespace.replace(/^cars-project-/, '');
  const deployments = kubectlJson(['-n', namespace, 'get', 'deployment', '-o', 'json'], true)?.items || [];
  const statefulsets = kubectlJson(['-n', namespace, 'get', 'statefulset', '-o', 'json'], true)?.items || [];
  const services = kubectlJson(['-n', namespace, 'get', 'service', '-o', 'json'], true)?.items || [];
  const pxcs = kubectlJson(['-n', namespace, 'get', 'pxc', '-o', 'json'], true)?.items || [];
  const pvcs = kubectlJson(['-n', namespace, 'get', 'pvc', '-o', 'json'], true)?.items || [];

  const appDeployment = deployments.find((item: any) =>
    item.metadata?.name?.startsWith(`cars-project-${projectId.substring(0, 24)}`) &&
    item.metadata?.name?.endsWith('-deployment')
  );
  const releaseName = appDeployment?.metadata?.name?.replace(/-deployment$/, '');
  const secretName = releaseName ? `${releaseName}-db-connection` : undefined;
  const secret = secretName ? readSecret(namespace, secretName) : undefined;
  const knexUrl = secret?.KNEX_URL;
  const mongoUrl = secret?.MONGO_URL || secret?.MONGO_URI;
  const dbResources = [
    ...statefulsets.map((item: any) => `statefulset/${item.metadata.name}`),
    ...deployments.map((item: any) => `deployment/${item.metadata.name}`),
    ...services.map((item: any) => `service/${item.metadata.name}`),
    ...pxcs.map((item: any) => `pxc/${item.metadata.name}`),
    ...pvcs.map((item: any) => `pvc/${item.metadata.name}`),
  ].filter(name => /mysql|mongo|haproxy|pxc|arbiter|datadir/i.test(name) && !name.endsWith(`${releaseName}-deployment`));

  if (!releaseName || !appDeployment) {
    return { namespace, projectId, dbResources, appReplicas: 0, status: 'manual-review', reason: 'No app deployment found' };
  }
  if (!secret) {
    return { namespace, projectId, releaseName, appDeployment: appDeployment.metadata.name, appReplicas: appDeployment.spec?.replicas || 0, secretName, dbResources, status: 'missing-secret' };
  }
  if (isSharedUrl(knexUrl) && isSharedUrl(mongoUrl)) {
    return { namespace, projectId, releaseName, appDeployment: appDeployment.metadata.name, appReplicas: appDeployment.spec?.replicas || 0, secretName, knexUrl, mongoUrl, dbResources, status: 'already-shared' };
  }
  if (!knexUrl && !mongoUrl) {
    return { namespace, projectId, releaseName, appDeployment: appDeployment.metadata.name, appReplicas: appDeployment.spec?.replicas || 0, secretName, dbResources, status: 'missing-source-db' };
  }

  return {
    namespace,
    projectId,
    releaseName,
    appDeployment: appDeployment.metadata.name,
    appReplicas: appDeployment.spec?.replicas || 0,
    secretName,
    knexUrl,
    mongoUrl,
    dbResources,
    status: 'ready',
  };
}

async function applyProjectMigration(discovery: Discovery) {
  const deployment = required(discovery.appDeployment, `${discovery.namespace}: missing app deployment`);
  const secretName = required(discovery.secretName, `${discovery.namespace}: missing DB secret`);
  const credentials = buildProjectDbCredentials(discovery.projectId);
  console.log(`${discovery.namespace}: provisioning shared DB users`);
  await ensureSharedProjectDatabases(credentials);

  try {
    console.log(`${discovery.namespace}: scaling ${deployment} to 0`);
    kubectl(['-n', discovery.namespace, 'scale', `deployment/${deployment}`, '--replicas=0']);

    if (discovery.knexUrl) {
      console.log(`${discovery.namespace}: migrating MySQL`);
      runMysqlMigrationJob(discovery.namespace, discovery.knexUrl, credentials.knexUrl);
    }
    if (discovery.mongoUrl) {
      console.log(`${discovery.namespace}: migrating MongoDB`);
      runMongoMigrationJob(discovery.namespace, discovery.mongoUrl, credentials.mongoUrl);
    }

    console.log(`${discovery.namespace}: patching ${secretName}`);
    kubectl([
      '-n', discovery.namespace,
      'patch', 'secret', secretName,
      '--type=merge',
      '-p', JSON.stringify({ stringData: { KNEX_URL: credentials.knexUrl, MONGO_URL: credentials.mongoUrl } }),
    ]);

    labelMigratedResources(discovery);
    scaleOldDbWorkloads(discovery);
  } catch (error) {
    if (discovery.appReplicas > 0) {
      kubectl(['-n', discovery.namespace, 'scale', `deployment/${deployment}`, `--replicas=${discovery.appReplicas}`], true);
    }
    throw error;
  }

  console.log(`${discovery.namespace}: restoring ${deployment} to ${discovery.appReplicas || 1}`);
  kubectl(['-n', discovery.namespace, 'scale', `deployment/${deployment}`, `--replicas=${discovery.appReplicas || 1}`]);
  kubectl(['-n', discovery.namespace, 'rollout', 'status', `deployment/${deployment}`, '--timeout=15m']);
}

function runMysqlMigrationJob(namespace: string, sourceUrl: string, targetUrl: string) {
  const source = parseMysqlUrl(sourceUrl);
  const target = parseMysqlUrl(targetUrl);
  runJob(namespace, 'mysql', 'mysql:8.0', {
    SOURCE_HOST: source.host,
    SOURCE_PORT: source.port,
    SOURCE_USER: source.user,
    SOURCE_PASSWORD: source.password,
    SOURCE_DATABASE: source.database,
    TARGET_HOST: target.host,
    TARGET_PORT: target.port,
    TARGET_USER: target.user,
    TARGET_PASSWORD: target.password,
    TARGET_DATABASE: target.database,
  }, `
set -euo pipefail
mysqldump -h "$SOURCE_HOST" -P "$SOURCE_PORT" -u "$SOURCE_USER" -p"$SOURCE_PASSWORD" --single-transaction --skip-lock-tables --skip-add-locks --hex-blob --routines --triggers --events --set-gtid-purged=OFF "$SOURCE_DATABASE" |
  mysql -h "$TARGET_HOST" -P "$TARGET_PORT" -u "$TARGET_USER" -p"$TARGET_PASSWORD" "$TARGET_DATABASE"
`);
}

function runMongoMigrationJob(namespace: string, sourceUrl: string, targetUrl: string) {
  const sourceDb = parseMongoDbName(sourceUrl);
  const targetDb = parseMongoDbName(targetUrl);
  runJob(namespace, 'mongo', 'mongo:6.0', {
    SOURCE_MONGO_URL: sourceUrl,
    TARGET_MONGO_URL: targetUrl,
    SOURCE_DB: sourceDb,
    TARGET_DB: targetDb,
  }, `
set -euo pipefail
mongodump --uri="$SOURCE_MONGO_URL" --db="$SOURCE_DB" --excludeCollection=system.users --excludeCollection=system.version --excludeCollection=system.roles --archive |
  mongorestore --uri="$TARGET_MONGO_URL" --archive --drop --nsFrom="$SOURCE_DB.*" --nsTo="$TARGET_DB.*"
`);
}

function migrateCarsMetadata(args: Args) {
  const sourceUrl = required(args.sourceUrl || process.env.MYSQL_DATABASE_URL, '--source-url or MYSQL_DATABASE_URL is required for --cars-metadata');
  const targetUrl = required(args.targetUrl, '--target-url is required for --cars-metadata');
  const namespace = getSharedDbConfig().namespace;
  if (args.dryRun) {
    console.log(JSON.stringify({
      mode: 'dry-run',
      task: 'cars-metadata',
      namespace,
      sourceDatabase: parseMysqlUrl(sourceUrl).database,
      targetDatabase: parseMysqlUrl(targetUrl).database,
    }, null, 2));
    return;
  }
  if (!args.apply) {
    throw new Error('--cars-metadata only supports --dry-run or --apply');
  }
  runMysqlMigrationJob(namespace, sourceUrl, targetUrl);
}

function runJob(namespace: string, purpose: string, image: string, env: Record<string, string>, script: string) {
  const name = `cars-shared-db-${purpose}-${Date.now().toString(36)}`.substring(0, 63);
  const manifest = `apiVersion: batch/v1
kind: Job
metadata:
  name: ${name}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/name: cars-shared-db-migration
    app.kubernetes.io/component: ${purpose}
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: ${image}
          command: ["/bin/bash", "-ec", ${yamlString(script)}]
          env:
${Object.entries(env).map(([key, value]) => `            - name: ${key}
              value: ${yamlString(value)}`).join('\n')}
`;
  kubectl(['apply', '-f', '-'], false, manifest);
  try {
    kubectl(['-n', namespace, 'wait', '--for=condition=complete', `job/${name}`, '--timeout=60m']);
  } catch (error) {
    kubectl(['-n', namespace, 'logs', `job/${name}`], true);
    throw error;
  } finally {
    kubectl(['-n', namespace, 'delete', `job/${name}`, '--ignore-not-found=true'], true);
  }
}

function labelMigratedResources(discovery: Discovery) {
  const resources = discovery.dbResources.filter(resource => !resource.includes(discovery.appDeployment || ''));
  if (!resources.length) {
    return;
  }
  kubectl(['-n', discovery.namespace, 'label', ...resources, 'cars.bsv.io/shared-db-migrated=true', '--overwrite'], true);
  kubectl(['-n', discovery.namespace, 'label', ...resources, 'velero.io/exclude-from-backup=true', '--overwrite'], true);
  kubectl(['-n', discovery.namespace, 'annotate', ...resources, 'velero.io/exclude-from-backup=true', '--overwrite'], true);
}

function scaleOldDbWorkloads(discovery: Discovery) {
  for (const resource of discovery.dbResources) {
    if (/^pxc\//.test(resource)) {
      kubectl(['-n', discovery.namespace, 'patch', resource, '--type=merge', '-p', '{"spec":{"pause":true}}'], true);
    }
    if (/^(statefulset|deployment)\/(mysql|mongo|.*pxc|.*haproxy|.*arbiter|mongo-rs|mongo-new|mysql-new)/.test(resource)) {
      kubectl(['-n', discovery.namespace, 'scale', resource, '--replicas=0'], true);
    }
  }
}

function pruneNamespace(discovery: Discovery) {
  console.log(`${discovery.namespace}: pruning DB resources previously labeled cars.bsv.io/shared-db-migrated=true`);
  kubectl([
    '-n', discovery.namespace,
    'delete',
    'pxc,statefulset,deployment,service,pvc',
    '-l', 'cars.bsv.io/shared-db-migrated=true',
    '--ignore-not-found=true',
  ]);
}

function readSecret(namespace: string, name: string): Record<string, string> | undefined {
  const doc = kubectlJson(['-n', namespace, 'get', 'secret', name, '-o', 'json'], true);
  if (!doc) {
    return undefined;
  }
  const decoded: Record<string, string> = {};
  for (const [key, value] of Object.entries(doc.data || {})) {
    decoded[key] = Buffer.from(String(value), 'base64').toString('utf8');
  }
  return decoded;
}

function isSharedUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  const config = getSharedDbConfig();
  return url.includes(config.mysqlAppHost) || config.mongoAppHosts.split(',').some(host => url.includes(host));
}

function redactDiscoveryForOutput(discovery: Discovery): Discovery {
  return {
    ...discovery,
    knexUrl: redactUrl(discovery.knexUrl),
    mongoUrl: redactUrl(discovery.mongoUrl),
  };
}

function redactUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) {
    return undefined;
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.password) {
      parsed.password = 'REDACTED';
    }
    return parsed.toString();
  } catch {
    return rawUrl.includes('@') ? '<redacted-url>' : rawUrl;
  }
}

function parseMysqlUrl(rawUrl: string) {
  const parsed = new URL(rawUrl);
  const database = parsed.pathname.replace(/^\//, '');
  if (!database) {
    throw new Error(`MySQL URL is missing a database name: ${rawUrl}`);
  }
  return {
    host: parsed.hostname,
    port: parsed.port || '3306',
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
  };
}

function parseMongoDbName(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  const database = parsed.pathname.replace(/^\//, '') || 'admin';
  return database;
}

function kubectlJson(args: string[], optional = false): any {
  try {
    return JSON.parse(kubectl(args, optional));
  } catch (error) {
    if (optional) {
      return undefined;
    }
    throw error;
  }
}

function kubectl(args: string[], optional = false, input?: string): string {
  const result = spawnSync('kubectl', args, {
    encoding: 'utf8',
    input,
    stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    if (optional) {
      return result.stdout || '';
    }
    throw new Error(`kubectl ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  return result.stdout || '';
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined || value === null || value === '') {
    throw new Error(message);
  }
  return value;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}
