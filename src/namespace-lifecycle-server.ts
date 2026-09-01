import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import 'express-async-errors';
import express from 'express';
import logger from './logger';
import { assertProjectId } from './namespace-lifecycle';

const serviceAccountName = process.env.CARS_RUNTIME_SERVICE_ACCOUNT || 'cars-operator-node';
const serviceAccountNamespace = process.env.CARS_RUNTIME_SERVICE_ACCOUNT_NAMESPACE || 'cars-operator-system';
const roleName = process.env.CARS_PROJECT_RUNTIME_ROLE || 'cars-project-runtime';
const bindingName = process.env.CARS_PROJECT_RUNTIME_BINDING || 'cars-project-runtime';
const namespacePrefix = 'cars-project-';
const requiredNamespaceLabels = {
  'app.kubernetes.io/managed-by': 'cars-namespace-lifecycle',
  'cars.bsv.io/managed': 'true',
  'pod-security.kubernetes.io/enforce': 'baseline',
  'pod-security.kubernetes.io/enforce-version': 'v1.34',
  'pod-security.kubernetes.io/audit': 'restricted',
  'pod-security.kubernetes.io/audit-version': 'v1.34',
  'pod-security.kubernetes.io/warn': 'restricted',
  'pod-security.kubernetes.io/warn-version': 'v1.34',
};

function listenPort(): number {
  const value = Number.parseInt(process.env.CARS_NAMESPACE_LIFECYCLE_LISTEN_PORT || '7780', 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error('CARS_NAMESPACE_LIFECYCLE_LISTEN_PORT must be a valid TCP port');
  }
  return value;
}

function token(): string {
  const value = process.env.CARS_NAMESPACE_LIFECYCLE_TOKEN;
  if (!value || value.length < 32) {
    throw new Error('CARS_NAMESPACE_LIFECYCLE_TOKEN must contain at least 32 characters');
  }
  return value;
}

function authorized(header: string | undefined): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice(7));
  const expected = Buffer.from(token());
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function namespaceName(projectId: string): string {
  assertProjectId(projectId);
  return `${namespacePrefix}${projectId}`;
}

function runKubectl(args: string[], input?: object, timeoutMs = 120000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('kubectl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const timeout = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    const collect = (target: Buffer[], chunk: Buffer) => {
      const value = Buffer.from(chunk);
      outputBytes += value.length;
      if (outputBytes > 16 * 1024 * 1024) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`kubectl ${args[0]} output exceeded 16 MiB`));
        return;
      }
      target.push(value);
    };
    child.stdout.on('data', chunk => collect(stdout, chunk));
    child.stderr.on('data', chunk => collect(stderr, chunk));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
        return;
      }
      const detail = Buffer.concat(stderr).toString('utf8').trim();
      reject(new Error(`kubectl ${args[0]} failed (${signal ? `signal ${signal}` : `exit ${code}`}): ${detail.slice(0, 800)}`));
    });
    if (input) child.stdin.end(JSON.stringify(input));
    else child.stdin.end();
  });
}

function namespaceDocument(projectId: string) {
  return {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: namespaceName(projectId),
      labels: {
        ...requiredNamespaceLabels,
        'cars.bsv.io/project-id': projectId,
      },
    },
  };
}

function bindingDocument(projectId: string) {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: {
      name: bindingName,
      namespace: namespaceName(projectId),
      labels: {
        'app.kubernetes.io/managed-by': 'cars-namespace-lifecycle',
        'cars.bsv.io/managed': 'true',
        'cars.bsv.io/project-id': projectId,
      },
    },
    roleRef: {
      apiGroup: 'rbac.authorization.k8s.io',
      kind: 'ClusterRole',
      name: roleName,
    },
    subjects: [{
      kind: 'ServiceAccount',
      name: serviceAccountName,
      namespace: serviceAccountNamespace,
    }],
  };
}

async function apply(document: object): Promise<void> {
  await runKubectl(['apply', '--server-side', '--field-manager=cars-namespace-lifecycle', '-f', '-'], document);
}

function bindingIsValid(binding: any, projectId: string): boolean {
  const subjects = binding?.subjects || [];
  return binding?.metadata?.name === bindingName &&
    binding?.metadata?.namespace === namespaceName(projectId) &&
    binding?.metadata?.labels?.['app.kubernetes.io/managed-by'] === 'cars-namespace-lifecycle' &&
    binding?.metadata?.labels?.['cars.bsv.io/managed'] === 'true' &&
    binding?.metadata?.labels?.['cars.bsv.io/project-id'] === projectId &&
    binding?.roleRef?.apiGroup === 'rbac.authorization.k8s.io' &&
    binding?.roleRef?.kind === 'ClusterRole' &&
    binding?.roleRef?.name === roleName &&
    subjects.length === 1 &&
    subjects[0]?.kind === 'ServiceAccount' &&
    subjects[0]?.name === serviceAccountName &&
    subjects[0]?.namespace === serviceAccountNamespace;
}

function namespaceIsValid(namespace: any, projectId: string): boolean {
  const labels = namespace?.metadata?.labels || {};
  return namespace?.metadata?.name === namespaceName(projectId) &&
    labels['cars.bsv.io/project-id'] === projectId &&
    Object.entries(requiredNamespaceLabels).every(([key, value]) => labels[key] === value);
}

async function ensure(projectId: string): Promise<void> {
  await apply(namespaceDocument(projectId));
  await apply(bindingDocument(projectId));
  const raw = await runKubectl(['-n', namespaceName(projectId), 'get', 'rolebinding', bindingName, '-o', 'json']);
  if (!bindingIsValid(JSON.parse(raw), projectId)) {
    throw new Error(`RoleBinding verification failed for ${namespaceName(projectId)}`);
  }
}

async function remove(projectId: string): Promise<void> {
  const namespace = namespaceName(projectId);
  await runKubectl(['delete', 'namespace', namespace, '--ignore-not-found=true', '--wait=true', '--timeout=120s'], undefined, 130000);
  try {
    await runKubectl(['get', 'namespace', namespace, '-o', 'name']);
    throw new Error(`Namespace ${namespace} still exists after deletion`);
  } catch (error: any) {
    if (!String(error?.message).includes('NotFound') && !String(error?.message).includes('not found')) throw error;
  }
}

async function audit(projectIds: string[]) {
  const expected = new Set(projectIds.map(projectId => {
    assertProjectId(projectId);
    return namespaceName(projectId);
  }));
  const namespaceList = JSON.parse(await runKubectl(['get', 'namespaces', '-l', 'cars.bsv.io/managed=true', '-o', 'json']));
  const bindingList = JSON.parse(await runKubectl(['get', 'rolebindings', '--all-namespaces', '-l', 'cars.bsv.io/managed=true', '-o', 'json']));
  const namespaceByName = new Map<string, any>((namespaceList.items || [])
    .map((item: any) => [item?.metadata?.name, item] as const)
    .filter(([name]) => Boolean(name)));
  const managed = new Set<string>(namespaceByName.keys());
  const bindingByNamespace = new Map<string, any>();
  for (const binding of bindingList.items || []) {
    if (binding?.metadata?.name === bindingName) bindingByNamespace.set(binding.metadata.namespace, binding);
  }
  const missingNamespaces = [...expected].filter(name => !managed.has(name)).sort();
  const orphanNamespaces = [...managed].filter(name => !expected.has(name)).sort();
  const invalidNamespaces = [...expected]
    .filter(name => managed.has(name))
    .filter(name => !namespaceIsValid(namespaceByName.get(name), name.slice(namespacePrefix.length)))
    .sort();
  const invalidBindings = [...expected]
    .filter(name => managed.has(name))
    .filter(name => !bindingIsValid(bindingByNamespace.get(name), name.slice(namespacePrefix.length)))
    .sort();
  return {
    status: missingNamespaces.length || orphanNamespaces.length || invalidNamespaces.length || invalidBindings.length ? 'error' : 'ok',
    expectedProjects: expected.size,
    managedNamespaces: managed.size,
    missingNamespaces,
    orphanNamespaces,
    invalidNamespaces,
    invalidBindings,
  };
}

export { namespaceDocument, bindingDocument, bindingIsValid, namespaceIsValid };

async function main() {
  token();
  const port = listenPort();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.get('/health/live', (_req, res) => res.json({ status: 'ok', live: true }));
  app.get('/health/ready', async (_req, res) => {
    try {
      const checks = [
        ['create', 'namespaces'],
        ['patch', 'namespaces'],
        ['delete', 'namespaces'],
        ['list', 'namespaces'],
        ['create', 'rolebindings', '--namespace', `${namespacePrefix}${'0'.repeat(32)}`],
        ['get', 'rolebindings', '--namespace', `${namespacePrefix}${'0'.repeat(32)}`],
        ['patch', 'rolebindings', '--namespace', `${namespacePrefix}${'0'.repeat(32)}`],
        ['list', 'rolebindings', '--all-namespaces'],
      ];
      for (const check of checks) {
        const allowed = (await runKubectl(['auth', 'can-i', ...check])).trim();
        if (allowed !== 'yes') throw new Error(`ServiceAccount cannot ${check[0]} ${check[1]}`);
      }
      res.json({ status: 'ok', ready: true });
    } catch {
      res.status(503).json({ status: 'error', ready: false });
    }
  });
  app.use((req, res, next) => {
    if (!authorized(req.header('authorization'))) return res.status(401).json({ error: 'Unauthorized' });
    next();
  });
  app.put('/v1/projects/:projectId', async (req, res) => {
    try {
      await ensure(req.params.projectId);
      res.json({ status: 'ok', namespace: namespaceName(req.params.projectId) });
    } catch (error: any) {
      logger.error({ projectId: req.params.projectId, error: error.message, alert: 'cars.namespace_lifecycle.ensure_failed' }, 'Namespace ensure failed');
      res.status(error?.statusCode === 400 ? 400 : 503).json({ error: 'Unable to ensure project namespace' });
    }
  });
  app.delete('/v1/projects/:projectId', async (req, res) => {
    try {
      await remove(req.params.projectId);
      res.json({ status: 'ok' });
    } catch (error: any) {
      logger.error({ projectId: req.params.projectId, error: error.message, alert: 'cars.namespace_lifecycle.delete_failed' }, 'Namespace deletion failed');
      res.status(error?.statusCode === 400 ? 400 : 503).json({ error: 'Unable to delete project namespace' });
    }
  });
  app.post('/v1/audit', async (req, res) => {
    try {
      if (
        !Array.isArray(req.body?.projectIds) || req.body.projectIds.length > 10000 ||
        req.body.projectIds.some((projectId: unknown) => typeof projectId !== 'string')
      ) {
        return res.status(400).json({ error: 'projectIds must be an array' });
      }
      const report = await audit(req.body.projectIds);
      res.status(report.status === 'ok' ? 200 : 409).json(report);
    } catch (error: any) {
      logger.error({ error: error.message, alert: 'cars.namespace_lifecycle.audit_failed' }, 'Namespace lifecycle audit failed');
      res.status(error?.statusCode === 400 ? 400 : 503).json({ error: 'Unable to audit project namespaces' });
    }
  });

  app.listen(port, '0.0.0.0', () => logger.info({ port }, 'CARS namespace lifecycle controller listening'));
}

if (require.main === module) {
  main().catch(error => {
    logger.fatal({ error: error.message, alert: 'cars.namespace_lifecycle.startup_failed' }, 'Namespace lifecycle controller failed to start');
    process.exit(1);
  });
}
