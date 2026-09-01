import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import express from 'express';
import logger from './logger';
import { assertProjectId } from './namespace-lifecycle';

const port = Number(process.env.CARS_NAMESPACE_LIFECYCLE_PORT || 7780);
const serviceAccountName = process.env.CARS_RUNTIME_SERVICE_ACCOUNT || 'cars-operator-node';
const serviceAccountNamespace = process.env.CARS_RUNTIME_SERVICE_ACCOUNT_NAMESPACE || 'cars-operator-system';
const roleName = process.env.CARS_PROJECT_RUNTIME_ROLE || 'cars-project-runtime';
const bindingName = process.env.CARS_PROJECT_RUNTIME_BINDING || 'cars-project-runtime';
const namespacePrefix = 'cars-project-';

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
    const timeout = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
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
        'app.kubernetes.io/managed-by': 'cars-namespace-lifecycle',
        'cars.bsv.io/managed': 'true',
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
    binding?.roleRef?.apiGroup === 'rbac.authorization.k8s.io' &&
    binding?.roleRef?.kind === 'ClusterRole' &&
    binding?.roleRef?.name === roleName &&
    subjects.length === 1 &&
    subjects[0]?.kind === 'ServiceAccount' &&
    subjects[0]?.name === serviceAccountName &&
    subjects[0]?.namespace === serviceAccountNamespace;
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
  const managed = new Set<string>((namespaceList.items || []).map((item: any) => item?.metadata?.name).filter(Boolean));
  const bindingByNamespace = new Map<string, any>();
  for (const binding of bindingList.items || []) {
    if (binding?.metadata?.name === bindingName) bindingByNamespace.set(binding.metadata.namespace, binding);
  }
  const missingNamespaces = [...expected].filter(name => !managed.has(name)).sort();
  const orphanNamespaces = [...managed].filter(name => !expected.has(name)).sort();
  const invalidBindings = [...expected]
    .filter(name => managed.has(name))
    .filter(name => !bindingIsValid(bindingByNamespace.get(name), name.slice(namespacePrefix.length)))
    .sort();
  return {
    status: missingNamespaces.length || orphanNamespaces.length || invalidBindings.length ? 'error' : 'ok',
    expectedProjects: expected.size,
    managedNamespaces: managed.size,
    missingNamespaces,
    orphanNamespaces,
    invalidBindings,
  };
}

export { namespaceDocument, bindingDocument, bindingIsValid };

async function main() {
  token();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.get('/health/live', (_req, res) => res.json({ status: 'ok', live: true }));
  app.get('/health/ready', async (_req, res) => {
    try {
      const allowed = (await runKubectl(['auth', 'can-i', 'create', 'namespaces'])).trim();
      if (allowed !== 'yes') throw new Error('ServiceAccount cannot create namespaces');
      res.json({ status: 'ok', ready: true });
    } catch (error: any) {
      logger.error({ error: error.message, alert: 'cars.namespace_lifecycle.not_ready' }, 'Namespace lifecycle readiness failed');
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
      if (!Array.isArray(req.body?.projectIds) || req.body.projectIds.length > 10000) {
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
