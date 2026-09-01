import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import 'express-async-errors';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import logger from './logger';
import { runCommand } from './process';
import type { BuildKind } from './build-controller';
import { deploymentWorkspaceRoot } from './deployment-workspace';

const projectIdPattern = /^[a-f0-9]{32}$/;
const deploymentIdPattern = /^[a-f0-9]{32}$/;
let buildActive = false;

function listenPort(): number {
  const value = Number.parseInt(process.env.CARS_BUILD_CONTROLLER_LISTEN_PORT || '7790', 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error('CARS_BUILD_CONTROLLER_LISTEN_PORT must be a valid TCP port');
  }
  return value;
}

function listenHost(): string {
  const value = process.env.CARS_BUILD_CONTROLLER_LISTEN_HOST || '127.0.0.1';
  if (value !== '127.0.0.1' && !(value === '0.0.0.0' && process.env.NODE_ENV !== 'production')) {
    throw new Error('CARS_BUILD_CONTROLLER_LISTEN_HOST must remain loopback in production');
  }
  return value;
}

function token(): string {
  const value = process.env.CARS_BUILD_CONTROLLER_TOKEN;
  if (!value || value.length < 32) {
    throw new Error('CARS_BUILD_CONTROLLER_TOKEN must contain at least 32 characters');
  }
  return value;
}

function authorized(header: string | undefined): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice(7));
  const expected = Buffer.from(token());
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function registry(): string {
  const value = process.env.DOCKER_REGISTRY || 'registry.cars-operator-system.svc.cluster.local:5000';
  if (!/^[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(value)) {
    throw new Error('DOCKER_REGISTRY is invalid');
  }
  return value;
}

async function validateRequest(body: any): Promise<{
  kind: BuildKind;
  projectId: string;
  deploymentId: string;
  contextDir: string;
  image: string;
}> {
  const { kind, projectId, deploymentId, contextDir, image } = body || {};
  if (kind !== 'frontend' && kind !== 'backend') throw new Error('Invalid build kind');
  if (!projectIdPattern.test(projectId)) throw new Error('Invalid project id');
  if (!deploymentIdPattern.test(deploymentId)) throw new Error('Invalid deployment id');
  const expectedDir = path.join(deploymentWorkspaceRoot(projectId, deploymentId), 'source', kind);
  if (contextDir !== expectedDir) throw new Error('Invalid build context');
  const resolved = await fs.realpath(expectedDir);
  if (resolved !== expectedDir) throw new Error('Invalid build context');
  const expectedImage = `${registry()}/cars-project-${projectId}/${kind}:${deploymentId}`;
  if (image !== expectedImage) throw new Error('Invalid destination image');
  return { kind, projectId, deploymentId, contextDir: expectedDir, image: expectedImage };
}

async function main() {
  token();
  registry();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.use(rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many build-controller requests' },
  }));
  app.get('/health/live', (_req, res) => res.json({ status: 'ok', live: true }));
  app.get('/health/ready', async (_req, res) => {
    try {
      await runCommand('buildah', ['--version'], { timeoutMs: 5000, maxOutputBytes: 4096 });
      res.json({ status: 'ok', ready: true, buildActive });
    } catch {
      res.status(503).json({ status: 'error', ready: false });
    }
  });
  app.use((req, res, next) => {
    if (!authorized(req.header('authorization'))) return res.status(401).json({ error: 'Unauthorized' });
    next();
  });
  app.post('/v1/build', async (req, res) => {
    if (buildActive) return res.status(429).json({ error: 'A build is already active on this CARS replica' });
    let build: Awaited<ReturnType<typeof validateRequest>> | undefined;
    try {
      build = await validateRequest(req.body);
      buildActive = true;
      logger.info(build, 'Starting isolated CARS image build');
      await runCommand('buildah', [
        'build', '--storage-driver=vfs', '--isolation=chroot', '--cap-drop=all',
        '-t', build.image, '.',
      ], { cwd: build.contextDir, stdio: 'inherit', timeoutMs: 90 * 60 * 1000 });
      await runCommand('buildah', [
        'push', '--storage-driver=vfs', '--tls-verify=false',
        '--digestfile', path.join(deploymentWorkspaceRoot(build.projectId, build.deploymentId), `push-${build.kind}.digest`),
        build.image,
      ], { cwd: build.contextDir, stdio: 'inherit', timeoutMs: 30 * 60 * 1000 });
      const digestPath = path.join(deploymentWorkspaceRoot(build.projectId, build.deploymentId), `push-${build.kind}.digest`);
      const digest = (await fs.readFile(digestPath, 'utf8')).trim();
      await fs.rm(digestPath, { force: true });
      if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
        throw new Error('Registry push did not return a valid immutable image digest');
      }
      const imageReference = `${build.image}@${digest}`;
      logger.info({ ...build, digest }, 'CARS image build and push completed');
      res.json({ status: 'ok', image: imageReference, digest });
    } catch (error: any) {
      logger.error({
        projectId: build?.projectId,
        deploymentId: build?.deploymentId,
        kind: build?.kind,
        error: error.message,
        alert: 'cars.build_controller.build_failed',
      }, 'CARS build controller failed');
      res.status(500).json({ error: 'Image build failed' });
    } finally {
      if (build?.image) {
        const digestPath = path.join(deploymentWorkspaceRoot(build.projectId, build.deploymentId), `push-${build.kind}.digest`);
        await fs.rm(digestPath, { force: true }).catch(() => undefined);
        await runCommand('buildah', [
          'rmi', '--storage-driver=vfs', build.image,
        ], { timeoutMs: 2 * 60 * 1000, maxOutputBytes: 256 * 1024 }).catch(error => {
          logger.warn({
            image: build?.image,
            error: error.message,
            alert: 'cars.build_controller.cleanup_failed',
          }, 'CARS build controller could not remove a completed tenant image');
        });
      }
      buildActive = false;
    }
  });
  const port = listenPort();
  const host = listenHost();
  app.listen(port, host, () => logger.info({ host, port }, 'CARS build controller listening'));
}

if (require.main === module) {
  main().catch(error => {
    logger.fatal({ error: error.message, alert: 'cars.build_controller.startup_failed' }, 'Build controller failed to start');
    process.exit(1);
  });
}
