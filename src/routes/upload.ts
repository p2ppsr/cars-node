import { Request, Response } from 'express';
import fs from 'fs-extra';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { Utils, type WalletInterface } from '@bsv/sdk';
import type { Knex } from 'knex';
import logger from '../logger';
import { extractTarGz } from '../archive';
import { buildProjectImage } from '../build-controller';
import { runCommand } from '../process';
import {
  CARSConfig,
  CARSConfigInfo,
  generateDockerfile,
  generateIndexTs,
  generatePackageJson,
  generateSafeAccessLoggerCjs,
  generateTsConfig,
  generateWaitScript,
} from '../utils';
import { sendDeploymentFailureEmail } from '../utils/email';
import {
  ProjectDbCredentials,
  buildProjectDbCredentials,
  ensureSharedProjectDatabases,
  getProjectDbMode,
  readProjectDbSecret,
} from '../shared-db';
import {
  normalizeProjectNetwork,
  projectNetworkToOverlayNetwork,
  propagationEnvironmentForNetwork,
  type ProjectNetwork,
} from '../network';
import { inspectProjectCapabilities, replaceProjectCapabilities } from '../advertisements/registry';
import { buildProjectIngressTls } from '../ingress-tls';
import { isPublicDiscoveryRoot } from '../public-discovery-root';
import { ensureProjectNamespace } from '../namespace-lifecycle';
import { deploymentWorkspaceRoot } from '../deployment-workspace';
import {
  DEFAULT_DISCOVERY_DENYLIST,
  serializeDiscoveryCapabilityDenylist,
} from '../discovery-denylist';

const projectsDomain: string = process.env.PROJECT_DEPLOYMENT_DNS_NAME!;
const deploymentIdPattern = /^[a-f0-9]{32}$/;
const signaturePattern = /^[a-f0-9]{64,512}$/;

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

const maxUploadBytes = boundedInteger('CARS_UPLOAD_MAX_BYTES', 1024 * 1024 * 1024, 1024, 4 * 1024 * 1024 * 1024);
const maxArchiveEntries = boundedInteger('CARS_ARCHIVE_MAX_ENTRIES', 50_000, 1, 200_000);
const maxArchiveExpandedBytes = boundedInteger('CARS_ARCHIVE_MAX_EXPANDED_BYTES', 2 * 1024 * 1024 * 1024, 1024, 8 * 1024 * 1024 * 1024);
const uploadUrlTtlMs = boundedInteger('CARS_UPLOAD_URL_TTL_MS', 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000);

function yamlString(value: string) {
  return JSON.stringify(value);
}

function readBoundedJson(file: string, label: string, maxBytes = 1024 * 1024): any {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) {
      throw new Error(`${label} must be a regular JSON file no larger than ${maxBytes} bytes`);
    }
    try {
      return JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    } catch {
      throw new Error(`${label} is not valid JSON`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function validateDeploymentInfo(value: any): asserts value is CARSConfigInfo {
  if (!isRecord(value) || value.schema !== 'bsv-app') throw new Error('Invalid schema in deployment-info.json');
  if (!Array.isArray(value.configs) || value.configs.length > 32 || value.configs.some((config: any) => !isRecord(config))) {
    throw new Error('deployment-info.json contains invalid configs');
  }
  const validateCapabilities = (record: any, kind: 'topic' | 'lookup') => {
    if (record == null) return;
    if (!isRecord(record) || Object.keys(record).length > 500) throw new Error(`Too many or invalid ${kind} capabilities`);
    for (const [name, definition] of Object.entries(record)) {
      if (name.length < 1 || name.length > 255 || /[\x00-\x1f\x7f]/.test(name)) throw new Error(`Invalid ${kind} capability name`);
      const sourcePath = kind === 'topic' ? definition : (definition as any)?.serviceFactory;
      if (typeof sourcePath !== 'string' || sourcePath.length < 1 || sourcePath.length > 1024 || /[\x00-\x1f\x7f]/.test(sourcePath)) {
        throw new Error(`Invalid ${kind} capability source path`);
      }
      if (kind === 'lookup' && ![undefined, 'mongo', 'knex'].includes((definition as any)?.hydrateWith)) {
        throw new Error('Invalid lookup capability hydration mode');
      }
    }
  };
  validateCapabilities(value.topicManagers, 'topic');
  validateCapabilities(value.lookupServices, 'lookup');
}

function validateDependencies(value: any): Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length > 500) throw new Error('Backend dependencies must be an object with at most 500 entries');
  for (const [name, version] of Object.entries(value)) {
    if (name.length < 1 || name.length > 214 || /[\x00-\x20\x7f]/.test(name) || typeof version !== 'string' || version.length < 1 || version.length > 512) {
      throw new Error('Backend dependency name or version is invalid');
    }
  }
  return value as Record<string, string>;
}

async function writeUploadToFile(req: Request, filePath: string) {
  await fs.ensureDir(path.dirname(filePath));
  const partialPath = `${filePath}.part`;
  await fs.remove(partialPath);

  let bytesWritten = 0;
  const body = (req as any).body;

  try {
    if (Buffer.isBuffer(body)) {
      bytesWritten = body.length;
      if (bytesWritten > maxUploadBytes) throw new Error(`Upload exceeds ${maxUploadBytes} bytes`);
      await fs.writeFile(partialPath, body);
    } else {
      const counter = new Transform({
        transform(chunk, _encoding, callback) {
          bytesWritten += chunk.length;
          if (bytesWritten > maxUploadBytes) {
            callback(new Error(`Upload exceeds ${maxUploadBytes} bytes`));
            return;
          }
          callback(null, chunk);
        }
      });
      await pipeline(req, counter, fs.createWriteStream(partialPath, { flags: 'wx' }));
    }

    await fs.move(partialPath, filePath, { overwrite: true });
    return bytesWritten;
  } catch (error) {
    await fs.remove(partialPath).catch(() => undefined);
    throw error;
  }
}

export default async (req: Request, res: Response) => {
  const { db, mainnetWallet: wallet }: {
    db: Knex;
    mainnetWallet: WalletInterface;
  } = req as any;
  const { deploymentId, signature } = req.params;
  let workspaceRoot: string | undefined;
  let filePath: string | undefined;
  let uploadDir: string | undefined;
  let claimed = false;

  // Helper function to log steps to DB logs and logger
  async function logStep(message: string, level: 'info' | 'error' = 'info') {
    const logObj = {
      project_id: deploy?.project_id,
      deploy_id: deploy?.id,
      message
    };
    await db('logs').insert(logObj);
    if (level === 'info') {
      logger.info({ deploymentId }, message);
    } else {
      logger.error({ deploymentId }, message);
    }
  }

  let deploy: any;
  let project: any;

  try {
    if (!deploymentIdPattern.test(deploymentId) || !signaturePattern.test(signature)) {
      return res.status(400).json({ error: 'Invalid upload credential' });
    }

    // 1) Validate deployment record
    deploy = await db('deploys').where({ deployment_uuid: deploymentId }).first();
    if (!deploy) {
      return res.status(400).json({ error: 'Invalid deploymentId' });
    }
    if (deploy.status !== 'pending') {
      return res.status(409).json({ error: 'Deployment upload URL has already been used' });
    }
    const createdAt = new Date(deploy.created_at).getTime();
    if (!Number.isFinite(createdAt) || createdAt > Date.now() + 5 * 60 * 1000 || Date.now() - createdAt > uploadUrlTtlMs) {
      await db('deploys').where({ id: deploy.id, status: 'pending' }).update({
        status: 'expired',
        error_message: 'Upload URL expired before use',
        completed_at: db.fn.now(),
      });
      return res.status(410).json({ error: 'Deployment upload URL has expired' });
    }

    // 2) Fetch project
    project = await db('projects').where({ id: deploy.project_id }).first();
    if (!project) {
      return res.status(400).json({ error: 'Project not found' });
    }

    // 3) Authenticate the single-use upload URL before reading any request body.
    const { valid } = await wallet.verifySignature({
      data: Utils.toArray(deploymentId, 'hex'),
      signature: Utils.toArray(signature, 'hex'),
      protocolID: [2, 'url signing'],
      keyID: deploymentId,
      counterparty: 'self'
    });
    if (!valid) return res.status(401).json({ error: 'Invalid signature' });

    workspaceRoot = deploymentWorkspaceRoot(project.project_uuid, deploymentId);
    filePath = path.join(workspaceRoot, 'artifact.tgz');
    uploadDir = path.join(workspaceRoot, 'source');

    const contentLength = req.header('content-length');
    if (contentLength) {
      const parsedLength = Number(contentLength);
      if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
        return res.status(400).json({ error: 'Invalid Content-Length' });
      }
      if (parsedLength > maxUploadBytes) {
        return res.status(413).json({ error: `Upload exceeds the ${maxUploadBytes}-byte limit` });
      }
    }

    // Namespace existence and the exact runtime RoleBinding are controller-owned.
    // Fail before accepting/building an artifact when that contract cannot be proven.
    await ensureProjectNamespace(project.project_uuid);

    // 4) Check project balance before accepting the upload body.
    if (project.balance < 1) {
      return res.status(401).json({ error: `Project balance must be at least 1 satoshi to upload a deployment. Current balance: ${project.balance}` });
    }

    const claimedRows = await db('deploys').where({ id: deploy.id, status: 'pending' }).update({
      status: 'uploading',
      error_message: null,
      accepted_at: db.fn.now(),
    });
    if (Number(claimedRows) !== 1) {
      return res.status(409).json({ error: 'Deployment upload URL has already been used' });
    }
    claimed = true;

    // 5) Stream the bounded authenticated artifact to a private scratch volume.
    const bytesWritten = await writeUploadToFile(req, filePath);
    await db('deploys').where({ id: deploy.id }).update({ file_path: filePath, status: 'processing' });
    await logStep(`File uploaded successfully, saved to ${filePath} (${bytesWritten} bytes)`);

    // Acknowledge the upload before the long-running build/push/helm workflow.
    // The deployment can then continue in the background without relying on a
    // single long-lived client socket surviving the full install.
    res.status(202).json({
      message: 'Upload accepted, deployment processing started',
      deploymentId,
      projectId: project.project_uuid,
    });

    // 6) Extract only regular files/directories inside strict count and size limits.
    const extracted = await extractTarGz(filePath, uploadDir, {
      maxEntries: maxArchiveEntries,
      maxExpandedBytes: maxArchiveExpandedBytes,
    });
    await logStep(`Tarball safely extracted at ${uploadDir} (${extracted.entries} entries, ${extracted.expandedBytes} bytes)`);

    // 8) Validate deployment-info.json
    const deploymentInfoPath = path.join(uploadDir, 'deployment-info.json');
    if (!fs.existsSync(deploymentInfoPath)) {
      const errMsg = 'deployment-info.json not found in tarball.';
      await logStep(errMsg, 'error');
      throw new Error(errMsg);
    }

    const deploymentInfo = readBoundedJson(deploymentInfoPath, 'deployment-info.json');
    validateDeploymentInfo(deploymentInfo);

    // 9) Check for matching CARS config
    const carsConfig: CARSConfig | undefined = deploymentInfo.configs?.find(
      (c: CARSConfig) =>
        c.provider === 'CARS' && c.projectID === project.project_uuid
    );

    if (!carsConfig || !carsConfig.projectID) {
      const errMsg = 'No matching CARS config or projectID in deployment-info.json';
      await logStep(errMsg, 'error');
      throw new Error(errMsg);
    }

    let deploymentNetwork: ProjectNetwork;
    try {
      deploymentNetwork = normalizeProjectNetwork(carsConfig.network);
    } catch (error: any) {
      const errMsg = error.message;
      await logStep(errMsg, 'error');
      throw new Error(errMsg);
    }
    const projectNetwork = normalizeProjectNetwork(project.network);
    if (deploymentNetwork !== projectNetwork) {
      const errMsg = `Network mismatch: Project is on ${project.network} but deployment config specifies ${carsConfig.network}`;
      await logStep(errMsg, 'error');
      throw new Error(errMsg);
    }

    // 10) Determine whether we are deploying a frontend and/or backend
    const deployTargets = carsConfig.deploy || [];
    if (!Array.isArray(deployTargets) || deployTargets.length > 2 || deployTargets.some(target => target !== 'frontend' && target !== 'backend')) {
      throw new Error('CARS deploy targets are invalid');
    }
    const backendEnabled = deployTargets.includes('backend');
    const frontendEnabled = deployTargets.includes('frontend');

    if (!frontendEnabled && !backendEnabled) {
      const errMsg = `No valid deploy targets found (must include "frontend" and/or "backend").`;
      await logStep(errMsg, 'error');
      throw new Error(errMsg);
    }

    // 11) Build/push Docker images
    const registryHost = process.env.DOCKER_REGISTRY || 'cars-registry:5000';
    let backendImage: string | null = null;
    let frontendImage: string | null = null;

    // --- Frontend build/push ---
    if (frontendEnabled) {
      frontendImage = `${registryHost}/cars-project-${project.project_uuid}/frontend:${deploymentId}`;
      await logStep('Building frontend image...');
      const frontendDir = path.join(uploadDir, 'frontend');
      if (!fs.existsSync(frontendDir)) {
        const errMsg = 'Frontend directory not found but frontend deployment requested.';
        await logStep(errMsg, 'error');
        throw new Error(errMsg);
      }

      // Add minimal NGINX configuration for static serving
      fs.writeFileSync(
        path.join(frontendDir, 'nginx.conf'),
        `server {
    listen 8080;
    server_name localhost;
    root /usr/share/nginx/html;

    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_comp_level 6;
    gzip_types
        application/javascript
        application/json
        application/manifest+json
        application/rss+xml
        image/svg+xml
        text/css
        text/javascript
        text/plain
        text/xml;

    location = /index.html {
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
    }

    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }

    location ~* \\.(?:avif|webp|jpg|jpeg|png|gif|ico|svg|woff2?)$ {
        add_header Cache-Control "public, max-age=604800, stale-while-revalidate=86400";
        try_files $uri =404;
    }

    location / {
        add_header Cache-Control "no-cache" always;
        # Serve directory-index and flat route-specific HTML shells before falling
        # back to the SPA. Directory indexes support static-site generators such as
        # Astro, while flat shells support routes such as /learn.html.
        try_files $uri/index.html $uri $uri.html /404.html /index.html;
    }
}`
      );

      // Dockerfile for serving static files
      fs.writeFileSync(
        path.join(frontendDir, 'Dockerfile'),
        `FROM docker.io/nginxinc/nginx-unprivileged:alpine@sha256:d9083fe47768377ef55dedafd67d4da7c2f2bc2bece7554954f29359deb0dce9
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY . /usr/share/nginx/html
EXPOSE 8080`
      );

      // Build + push in the isolated, tokenless build sidecar.
      frontendImage = await buildProjectImage({
        kind: 'frontend',
        projectId: project.project_uuid,
        deploymentId,
        contextDir: frontendDir,
        image: frontendImage,
      });
      await logStep(`Frontend image built: ${frontendImage}`);
      await logStep(`Frontend image pushed: ${frontendImage}`);
    }

    // --- Backend build/push ---
    if (backendEnabled) {
      backendImage = `${registryHost}/cars-project-${project.project_uuid}/backend:${deploymentId}`;
      await logStep('Building backend image...');
      const backendDir = path.join(uploadDir, 'backend');
      if (!fs.existsSync(backendDir)) {
        const errMsg = 'Backend directory not found but backend deployment requested.';
        await logStep(errMsg, 'error');
        throw new Error(errMsg);
      }

      const backendPackageJsonPath = path.join(backendDir, 'package.json');
      if (!fs.existsSync(backendPackageJsonPath)) {
        const errMsg = 'Backend directory does not contain a package.json file.';
        await logStep(errMsg, 'error');
        throw new Error(errMsg);
      }

      const backendPackageJson = readBoundedJson(backendPackageJsonPath, 'backend/package.json');
      const backendDependencies = validateDependencies(backendPackageJson.dependencies);

      // Check if sCrypt contract compilation is needed
      let enableContracts = false;
      if (deploymentInfo.contracts && deploymentInfo.contracts.language === 'sCrypt') {
        enableContracts = true;
      } else if (
        deploymentInfo.contracts &&
        deploymentInfo.contracts.language &&
        deploymentInfo.contracts.language !== 'sCrypt'
      ) {
        const errMsg = `BSV Contract language not supported: ${deploymentInfo.contracts.language}`;
        await logStep(errMsg, 'error');
        throw new Error(errMsg);
      }

      // Create supporting files for Docker build
      fs.writeFileSync(
        path.join(backendDir, 'Dockerfile'),
        generateDockerfile(enableContracts)
      );
      fs.writeFileSync(path.join(backendDir, 'wait-for-services.sh'), generateWaitScript());
      fs.writeFileSync(path.join(backendDir, 'safe-access-logger.cjs'), generateSafeAccessLoggerCjs());
      fs.writeFileSync(path.join(backendDir, 'tsconfig.json'), generateTsConfig());
      fs.writeFileSync(
        path.join(backendDir, 'package.json'),
        JSON.stringify(generatePackageJson(backendDependencies), null, 2)
      );
      fs.writeFileSync(path.join(backendDir, 'index.ts'), generateIndexTs(deploymentInfo));

      // Build + push in the isolated, tokenless build sidecar.
      backendImage = await buildProjectImage({
        kind: 'backend',
        projectId: project.project_uuid,
        deploymentId,
        contextDir: backendDir,
        image: backendImage,
      });
      await logStep(`Backend image built: ${backendImage}`);
      await logStep(`Backend image pushed: ${backendImage}`);
    }

    // 12) Prepare environment variables
    let webUiConfigObj = {};
    if (project.web_ui_config) {
      try {
        webUiConfigObj = JSON.parse(project.web_ui_config);
      } catch {
        webUiConfigObj = {};
      }
    }

    let engineConfigObj: any = {};
    try {
      engineConfigObj = project.engine_config ? JSON.parse(project.engine_config) : {};
    } catch (e) {
      engineConfigObj = {};
    }

    const gaspSyncEnv = engineConfigObj.gaspSync === true ? 'true' : 'false';
    const requestLoggingEnv = 'false';
    const safeRequestLoggingEnv = 'true';
    const syncConfigJson = JSON.stringify(engineConfigObj.syncConfiguration || {});
    const logTimeEnv = engineConfigObj.logTime === true ? 'true' : 'false';
    const logPrefixEnv = typeof engineConfigObj.logPrefix === 'string' ? engineConfigObj.logPrefix : '[CARS OVERLAY ENGINE] ';
    const throwOnBroadcastFailEnv = engineConfigObj.throwOnBroadcastFailure === true ? 'true' : 'false';
    const adminBearerTokenEnv = project.admin_bearer_token || '';
    const suppressDefaultSyncAdvertisements = engineConfigObj.suppressDefaultSyncAdvertisements === false ? 'false' : 'true';
    const publicDiscoveryRootEnv = isPublicDiscoveryRoot(project.backend_custom_domain) ? 'true' : 'false';
    const discoveryDenylistEnv = publicDiscoveryRootEnv === 'true'
      ? DEFAULT_DISCOVERY_DENYLIST.join(',')
      : '';
    const discoveryCapabilityDenylistEnv = publicDiscoveryRootEnv === 'true'
      ? serializeDiscoveryCapabilityDenylist()
      : '';

    const overlayNetwork = projectNetworkToOverlayNetwork(projectNetwork);
    const propagationProviderEnv = Object.entries(
      propagationEnvironmentForNetwork(projectNetwork, project.project_uuid)
    ).map(([name, value]) => `        - name: ${name}\n          value: ${yamlString(value)}\n`).join('');

    // 14) Generate Helm chart
    const helmDir = path.join(uploadDir, 'helm');
    fs.ensureDirSync(helmDir);

    // Chart.yaml
    fs.writeFileSync(
      path.join(helmDir, 'Chart.yaml'),
      `apiVersion: v2
name: cars-project
version: 0.1.0
description: A chart to deploy a CARS project
`
    );

    const namespace = `cars-project-${project.project_uuid}`;
    const helmReleaseName = `cars-project-${project.project_uuid.substr(0, 24)}`;
    const projectDbMode = getProjectDbMode();
    const useMySQL = backendEnabled && projectDbMode === 'legacy-per-project';
    const useMongo = backendEnabled && projectDbMode === 'legacy-per-project';
    let sharedDbCredentials: ProjectDbCredentials | undefined;

    if (backendEnabled && projectDbMode === 'shared') {
      const existingSecret = readProjectDbSecret(namespace, `${helmReleaseName}-db-connection`);
      if (!existingSecret) {
        const previousSuccessfulDeploy = await db('deploys')
          .where({ project_id: project.id, status: 'succeeded' })
          .whereNot({ id: deploy.id })
          .first('id');
        if (previousSuccessfulDeploy) {
          throw new Error('Existing project database credentials are missing; refusing unsafe credential rotation');
        }
      }
      sharedDbCredentials = buildProjectDbCredentials(project.project_uuid, existingSecret);
      await ensureSharedProjectDatabases(sharedDbCredentials);
      await logStep(`Shared database credentials provisioned for ${project.project_uuid}`);
    }

    const ingressHost = `${project.project_uuid}.${projectsDomain}`;

    // Values for the chart
    const valuesObj = {
      backendImage,
      frontendImage,
      ingressHostFrontend: `frontend.${ingressHost}`,
      ingressCustomFrontend: project.frontend_custom_domain,
      ingressHostBackend: `backend.${ingressHost}`,
      ingressCustomBackend: project.backend_custom_domain,
      useMySQL,
      useMongo,
      projectDbMode,
      appReplicas: 2,
      appMinReplicas: 2,
      appMaxReplicas: 4,
      computeNodes: ['server2', 'server3'],
      storageWitnessNode: 'box',
      mysqlServiceName: sharedDbCredentials?.mysqlWaitHost || 'mysql-ha',
      mongoReplicaSetName: 'rs0',
      mongoServiceName: 'mongo-rs',
      mongoWaitHost: sharedDbCredentials?.mongoWaitHost || `mongo-rs-0.mongo-rs.${namespace}.svc.cluster.local`,
      storageClass: 'longhorn-replicated',
      storage: {
        mysqlSize: '20Gi',
        mongoSize: '20Gi',
      },
    };

    fs.writeFileSync(path.join(helmDir, 'values.yaml'), JSON.stringify(valuesObj, null, 2));

    fs.ensureDirSync(path.join(helmDir, 'templates'));

    // _helpers.tpl
    fs.writeFileSync(
      path.join(helmDir, 'templates', '_helpers.tpl'),
      `{{- define "cars-project.fullname" -}}
{{- .Release.Name -}}
{{- end }}
`
    );

    if (backendEnabled && (!sharedDbCredentials || projectDbMode !== 'shared')) {
      throw new Error('Secure shared database credentials were not provisioned');
    }
    fs.writeFileSync(
      path.join(helmDir, 'templates', 'db-secrets.yaml'),
      backendEnabled && sharedDbCredentials
        ? `{{- if .Values.backendImage }}
apiVersion: v1
kind: Secret
metadata:
  name: {{ include "cars-project.fullname" . }}-db-connection
  labels:
    app: {{ include "cars-project.fullname" . }}
    cars.bsv.io/db-mode: shared
type: Opaque
stringData:
  KNEX_URL: ${yamlString(sharedDbCredentials.knexUrl)}
  MONGO_URL: ${yamlString(sharedDbCredentials.mongoUrl)}
  ADMIN_BEARER_TOKEN: ${yamlString(adminBearerTokenEnv)}
{{- end }}
`
        : ''
    );

    //
    // 14a) Main Deployment for our app (frontend + backend)
    //
    fs.writeFileSync(
      path.join(helmDir, 'templates', 'deployment.yaml'),
      `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "cars-project.fullname" . }}-deployment
  labels:
    app: {{ include "cars-project.fullname" . }}
spec:
  replicas: {{ .Values.appReplicas }}
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 1
  selector:
    matchLabels:
      app: {{ include "cars-project.fullname" . }}
  template:
    metadata:
      labels:
        app: {{ include "cars-project.fullname" . }}
    spec:
      automountServiceAccountToken: false
      enableServiceLinks: false
      securityContext:
        fsGroup: 65532
        fsGroupChangePolicy: OnRootMismatch
        seccompProfile:
          type: RuntimeDefault
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: kubernetes.io/hostname
                    operator: In
                    values:
                      {{- range .Values.computeNodes }}
                      - {{ . | quote }}
                      {{- end }}
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                topologyKey: kubernetes.io/hostname
                labelSelector:
                  matchLabels:
                    app: {{ include "cars-project.fullname" . }}
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: {{ include "cars-project.fullname" . }}
      {{- if .Values.backendImage }}
      initContainers:
      - name: wait-for-mysql
        image: docker.io/library/busybox:1.36@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662
        command:
          - /bin/sh
          - -ec
          - |
            until nc -z {{ .Values.mysqlServiceName }} 3306; do
              sleep 5
            done
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop: ["ALL"]
          runAsNonRoot: true
          runAsUser: 65532
      - name: wait-for-mongo
        image: docker.io/library/busybox:1.36@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662
        command:
          - /bin/sh
          - -ec
          - |
            until nc -z {{ .Values.mongoWaitHost }} 27017; do
              sleep 5
            done
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop: ["ALL"]
          runAsNonRoot: true
          runAsUser: 65532
      {{- end }}
      containers:
      {{- if .Values.backendImage }}
      - name: backend
        image: {{ .Values.backendImage }}
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop: ["ALL"]
          readOnlyRootFilesystem: true
          runAsNonRoot: true
          runAsUser: 1000
        env:
        - name: HOSTING_URL
          value: "{{ .Values.ingressHostBackend }}"
        - name: REQUEST_LOGGING
          value: ${yamlString(requestLoggingEnv)}
        - name: SAFE_REQUEST_LOGGING
          value: ${yamlString(safeRequestLoggingEnv)}
        - name: CARS_PUBLIC_DISCOVERY_ROOT
          value: ${yamlString(publicDiscoveryRootEnv)}
        - name: CARS_BANNED_AD_DOMAINS
          value: ${yamlString(discoveryDenylistEnv)}
        - name: CARS_BANNED_AD_CAPABILITIES
          value: ${yamlString(discoveryCapabilityDenylistEnv)}
        - name: GASP_SYNC
          value: ${yamlString(gaspSyncEnv)}
        - name: NETWORK
          value: ${yamlString(overlayNetwork)}
${propagationProviderEnv}        - name: KNEX_URL
          valueFrom:
            secretKeyRef:
              name: {{ include "cars-project.fullname" . }}-db-connection
              key: KNEX_URL
        - name: MYSQL_WAIT_HOST
          value: "{{ .Values.mysqlServiceName }}"
        - name: MYSQL_WAIT_PORT
          value: "3306"
        - name: MONGO_URL
          valueFrom:
            secretKeyRef:
              name: {{ include "cars-project.fullname" . }}-db-connection
              key: MONGO_URL
        - name: MONGO_WAIT_HOST
          value: "{{ .Values.mongoWaitHost }}"
        - name: MONGO_WAIT_PORT
          value: "27017"
        - name: WEB_UI_CONFIG
          value: |-
            ${JSON.stringify(webUiConfigObj)}
        - name: ADMIN_BEARER_TOKEN
          valueFrom:
            secretKeyRef:
              name: {{ include "cars-project.fullname" . }}-db-connection
              key: ADMIN_BEARER_TOKEN
        - name: LOG_TIME
          value: ${yamlString(logTimeEnv)}
        - name: LOG_PREFIX
          value: ${yamlString(logPrefixEnv)}
        - name: SUPPRESS_DEFAULT_SYNC_ADVERTISEMENTS
          value: ${yamlString(suppressDefaultSyncAdvertisements)}
        - name: THROW_ON_BROADCAST_FAIL
          value: ${yamlString(throwOnBroadcastFailEnv)}
        - name: SYNC_CONFIG_JSON
          value: |-
            ${syncConfigJson}
        ports:
        - containerPort: 8080
        startupProbe:
          tcpSocket:
            port: 8080
          failureThreshold: 30
          periodSeconds: 10
        readinessProbe:
          tcpSocket:
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 10
          timeoutSeconds: 5
        livenessProbe:
          tcpSocket:
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 20
          timeoutSeconds: 5
        resources:
          requests:
            cpu: 100m  
        volumeMounts:
        - name: tmp
          mountPath: /tmp
      {{- end }}
      {{- if .Values.frontendImage }}
      - name: frontend
        image: {{ .Values.frontendImage }}
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop: ["ALL"]
          readOnlyRootFilesystem: true
          runAsNonRoot: true
          runAsUser: 101
        ports:
        - containerPort: 8080
        readinessProbe:
          httpGet:
            path: /
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10
        livenessProbe:
          httpGet:
            path: /
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 20
        resources:
          requests:
            cpu: 100m  
        volumeMounts:
        - name: tmp
          mountPath: /tmp
      {{- end }}
      volumes:
      - name: tmp
        emptyDir:
          sizeLimit: 256Mi
`
    );

    //
    // 14b) HorizontalPodAutoscaler for our app (frontend + backend)
    //
    fs.writeFileSync(
      path.join(helmDir, 'templates', 'hpa.yaml'),
      `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ include "cars-project.fullname" . }}-deployment
  labels:
    app: {{ include "cars-project.fullname" . }}
spec:
  maxReplicas: {{ .Values.appMaxReplicas }}
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 120
      policies:
      - type: Pods
        value: 1
        periodSeconds: 120
      selectPolicy: Min
    scaleDown:
      stabilizationWindowSeconds: 60
  metrics:
  - resource:
      name: cpu
      target:
        averageUtilization: 200
        type: Utilization
    type: Resource
  minReplicas: {{ .Values.appMinReplicas }}
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ include "cars-project.fullname" . }}-deployment
`
    );

    fs.writeFileSync(
      path.join(helmDir, 'templates', 'pdb.yaml'),
      `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ include "cars-project.fullname" . }}-deployment
  labels:
    app: {{ include "cars-project.fullname" . }}
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: {{ include "cars-project.fullname" . }}
`
    );

    fs.writeFileSync(
      path.join(helmDir, 'templates', 'network-policy.yaml'),
      `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {{ include "cars-project.fullname" . }}-ingress
  labels:
    app: {{ include "cars-project.fullname" . }}
spec:
  podSelector:
    matchLabels:
      app: {{ include "cars-project.fullname" . }}
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: cars-operator-system
      ports:
        {{- if .Values.backendImage }}
        - protocol: TCP
          port: 8080
        {{- end }}
        {{- if .Values.frontendImage }}
        - protocol: TCP
          port: 8080
        {{- end }}
`
    );

    //
    // 14c) Service for our combined Pod
    //
    fs.writeFileSync(
      path.join(helmDir, 'templates', 'service.yaml'),
      `apiVersion: v1
kind: Service
metadata:
  name: {{ include "cars-project.fullname" . }}-service
  labels:
    app: {{ include "cars-project.fullname" . }}
spec:
  sessionAffinity: ClientIP
  sessionAffinityConfig:
    clientIP:
      timeoutSeconds: 10800
  selector:
    app: {{ include "cars-project.fullname" . }}
  ports:
  {{- if .Values.backendImage }}
  - port: 8080
    targetPort: 8080
    protocol: TCP
    name: backend
  {{- end }}
  {{- if .Values.frontendImage }}
  - port: 80
    targetPort: 8080
    protocol: TCP
    name: frontend
  {{- end }}
`
    );

    //
    // 14d) Ingress for both frontend and backend
    //
    const ingressTls = buildProjectIngressTls({
      projectUuid: project.project_uuid,
      frontendEnabled,
      backendEnabled,
      frontendCustomDomain: valuesObj.ingressCustomFrontend,
      backendCustomDomain: valuesObj.ingressCustomBackend,
    });

    let ingressYaml = `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ include "cars-project.fullname" . }}-ingress
  labels:
    app: {{ include "cars-project.fullname" . }}
    created-by: cars
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-production"
    nginx.ingress.kubernetes.io/affinity: "cookie"
    nginx.ingress.kubernetes.io/affinity-mode: "persistent"
    nginx.ingress.kubernetes.io/session-cookie-name: "route"
    nginx.ingress.kubernetes.io/session-cookie-max-age: "86400"
    nginx.ingress.kubernetes.io/session-cookie-expires: "86400"
spec:
  ingressClassName: nginx
  tls:
${ingressTls}  rules:
`;

    if (frontendEnabled) {
      ingressYaml += `
  - host: {{ .Values.ingressHostFrontend }}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: {{ include "cars-project.fullname" . }}-service
            port:
              number: 80
`;
      if (project.frontend_custom_domain) {
        ingressYaml += `
  - host: {{ .Values.ingressCustomFrontend }}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: {{ include "cars-project.fullname" . }}-service
            port:
              number: 80
`;
      }
    }
    if (backendEnabled) {
      ingressYaml += `
  - host: {{ .Values.ingressHostBackend }}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: {{ include "cars-project.fullname" . }}-service
            port:
              number: 8080
`;
      if (project.backend_custom_domain) {
        ingressYaml += `
  - host: {{ .Values.ingressCustomBackend }}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: {{ include "cars-project.fullname" . }}-service
            port:
              number: 8080
`;
      }
    }

    fs.writeFileSync(
      path.join(helmDir, 'templates', 'ingress.yaml'),
      ingressYaml
    );


    //
    // 14e) MySQL: Percona XtraDB Cluster + HAProxy Service (only if useMySQL)
    //
    fs.writeFileSync(
      path.join(helmDir, 'templates', 'mysql-pxc.yaml'),
      `{{- if .Values.useMySQL }}
apiVersion: v1
kind: Secret
metadata:
  name: mysql-secrets
  labels:
    app: mysql
type: Opaque
stringData:
  root: "legacy-mode-disabled"
  xtrabackup: "legacy-mode-disabled"
  monitor: "legacy-mode-disabled"
  proxyadmin: "legacy-mode-disabled"
  clustercheck: "legacy-mode-disabled"
  operator: "legacy-mode-disabled"
  replication: "legacy-mode-disabled"
---
apiVersion: pxc.percona.com/v1
kind: PerconaXtraDBCluster
metadata:
  name: mysql
  labels:
    app: mysql
spec:
  crVersion: 1.20.0
  secretsName: mysql-secrets
  updateStrategy: SmartUpdate
  allowUnsafeConfigurations: false
  unsafeFlags:
    tls: true
  pxc:
    size: 3
    image: percona/percona-xtradb-cluster:8.4.10-10.1@sha256:c4c9f39ce0b4cff7bccc2c138c08ed60e78deb8539d0e1e3a51fbb2ce3db7875
    autoRecovery: true
    resources:
      requests:
        cpu: "250m"
        memory: "512M"
      limits:
        cpu: "600m"
        memory: "1G"
    tolerations:
      - key: "storage.longhorn.io/node"
        operator: "Equal"
        value: "true"
        effect: "NoSchedule"
    podDisruptionBudget:
      maxUnavailable: 1
    affinity:
      advanced:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - topologyKey: kubernetes.io/hostname
              labelSelector:
                matchLabels:
                  app.kubernetes.io/component: pxc
                  app.kubernetes.io/instance: mysql
    volumeSpec:
      persistentVolumeClaim:
        storageClassName: {{ .Values.storageClass | quote }}
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: {{ .Values.storage.mysqlSize | quote }}
  haproxy:
    enabled: true
    image: docker.io/percona/haproxy:2.8.18-1@sha256:726b65930d86f7342eb6bce97a38b9af934c935345e4524afda6b65c2b3213b3
    size: 2
    resources:
      requests:
        cpu: "150m"
        memory: "256M"
      limits:
        cpu: "400m"
        memory: "512M"
    podDisruptionBudget:
      minAvailable: 1
    affinity:
      advanced:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                topologyKey: kubernetes.io/hostname
                labelSelector:
                  matchLabels:
                    app.kubernetes.io/component: haproxy
                    app.kubernetes.io/instance: mysql
---
apiVersion: v1
kind: Service
metadata:
  name: {{ .Values.mysqlServiceName }}
  labels:
    app: mysql-ha
spec:
  selector:
    app.kubernetes.io/component: haproxy
    app.kubernetes.io/instance: mysql
  ports:
    - port: 3306
      targetPort: 3306
      protocol: TCP
      name: mysql
---
apiVersion: batch/v1
kind: Job
metadata:
  name: mysql-bootstrap
  labels:
    app: mysql
  annotations:
    "helm.sh/hook": post-install,post-upgrade
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  backoffLimit: 6
  template:
    metadata:
      labels:
        app: mysql-bootstrap
    spec:
      restartPolicy: OnFailure
      containers:
        - name: mysql-bootstrap
          image: docker.io/library/mysql:8.0@sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b
          command:
            - /bin/sh
            - -ec
            - |
              until mysql -h {{ .Values.mysqlServiceName }} -uroot -p"$MYSQL_ROOT_PASSWORD" -e 'select 1'; do
                sleep 10
              done
              mysql -h {{ .Values.mysqlServiceName }} -uroot -p"$MYSQL_ROOT_PASSWORD" <<'SQL'
              CREATE DATABASE IF NOT EXISTS projectdb;
              CREATE USER IF NOT EXISTS 'projectUser'@'%' IDENTIFIED BY 'legacy-mode-disabled';
              GRANT ALL PRIVILEGES ON projectdb.* TO 'projectUser'@'%';
              FLUSH PRIVILEGES;
              SQL
          env:
            - name: MYSQL_ROOT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ include "cars-project.fullname" . }}-db-connection
                  key: MYSQL_ROOT_PASSWORD
{{- end }}
`
    );

    //
    // 14f) MongoDB: replica set + arbiter (only if useMongo)
    //
    fs.writeFileSync(
      path.join(helmDir, 'templates', 'mongo-rs.yaml'),
      `{{- if .Values.useMongo }}
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mongo-rs
  labels:
    app: mongo
spec:
  serviceName: {{ .Values.mongoServiceName }}
  replicas: 2
  selector:
    matchLabels:
      app: mongo-rs
  template:
    metadata:
      labels:
        app: mongo-rs
    spec:
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: kubernetes.io/hostname
                    operator: In
                    values:
                      {{- range .Values.computeNodes }}
                      - {{ . | quote }}
                      {{- end }}
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - topologyKey: kubernetes.io/hostname
              labelSelector:
                matchLabels:
                  app: mongo-rs
      initContainers:
        - name: prepare-keyfile
          image: docker.io/library/busybox:1.36@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662
          command:
            - /bin/sh
            - -ec
            - |
              cp /etc/mongo-keyfile-secret/keyfile /workdir/keyfile
              chmod 600 /workdir/keyfile
              chown 999:999 /workdir/keyfile
          volumeMounts:
            - name: mongo-keyfile-secret
              mountPath: /etc/mongo-keyfile-secret
              readOnly: true
            - name: mongo-keyfile
              mountPath: /workdir
      containers:
        - name: mongo
          image: docker.io/library/mongo:6.0@sha256:8b6d8f5bbedb25cb73517b65cf99f13aeb75ad5b157a56c479287a840bbad3ac
          env:
            - name: MONGO_INITDB_ROOT_USERNAME
              valueFrom:
                secretKeyRef:
                  name: {{ include "cars-project.fullname" . }}-db-connection
                  key: MONGO_ROOT_USERNAME
            - name: MONGO_INITDB_ROOT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ include "cars-project.fullname" . }}-db-connection
                  key: MONGO_ROOT_PASSWORD
          args:
            - "--bind_ip_all"
            - "--replSet"
            - "{{ .Values.mongoReplicaSetName }}"
            - "--auth"
            - "--keyFile=/etc/mongo-keyfile/keyfile"
          ports:
            - containerPort: 27017
          volumeMounts:
            - name: mongo-data
              mountPath: /data/db
            - name: mongo-keyfile
              mountPath: /etc/mongo-keyfile
              readOnly: true
      volumes:
        - name: mongo-keyfile
          emptyDir: {}
        - name: mongo-keyfile-secret
          secret:
            secretName: {{ include "cars-project.fullname" . }}-db-connection
            items:
              - key: MONGO_RS_KEY
                path: keyfile
      securityContext:
        fsGroup: 999
        fsGroupChangePolicy: "OnRootMismatch"
  volumeClaimTemplates:
    - metadata:
        name: mongo-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: {{ .Values.storageClass | quote }}
        resources:
          requests:
            storage: {{ .Values.storage.mongoSize | quote }}

---
apiVersion: v1
kind: Service
metadata:
  name: {{ .Values.mongoServiceName }}
  labels:
    app: mongo-rs
spec:
  clusterIP: None
  publishNotReadyAddresses: true
  selector:
    app: mongo-rs
  ports:
    - port: 27017
      targetPort: 27017
      protocol: TCP
      name: mongo
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mongo-arbiter
  labels:
    app: mongo-arbiter
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mongo-arbiter
  template:
    metadata:
      labels:
        app: mongo-arbiter
    spec:
      nodeSelector:
        kubernetes.io/hostname: {{ .Values.storageWitnessNode | quote }}
      tolerations:
        - key: "storage.longhorn.io/node"
          operator: "Equal"
          value: "true"
          effect: "NoSchedule"
      containers:
        - name: mongo-arbiter
          image: docker.io/library/mongo:6.0@sha256:8b6d8f5bbedb25cb73517b65cf99f13aeb75ad5b157a56c479287a840bbad3ac
          env:
            - name: MONGO_INITDB_ROOT_USERNAME
              valueFrom:
                secretKeyRef:
                  name: {{ include "cars-project.fullname" . }}-db-connection
                  key: MONGO_ROOT_USERNAME
            - name: MONGO_INITDB_ROOT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ include "cars-project.fullname" . }}-db-connection
                  key: MONGO_ROOT_PASSWORD
          args:
            - "--bind_ip_all"
            - "--replSet"
            - "{{ .Values.mongoReplicaSetName }}"
            - "--auth"
            - "--keyFile=/etc/mongo-keyfile/keyfile"
          ports:
            - containerPort: 27017
          volumeMounts:
            - name: mongo-keyfile
              mountPath: /etc/mongo-keyfile
              readOnly: true
      initContainers:
        - name: prepare-keyfile
          image: docker.io/library/busybox:1.36@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662
          command:
            - /bin/sh
            - -ec
            - |
              cp /etc/mongo-keyfile-secret/keyfile /workdir/keyfile
              chmod 600 /workdir/keyfile
              chown 999:999 /workdir/keyfile
          volumeMounts:
            - name: mongo-keyfile-secret
              mountPath: /etc/mongo-keyfile-secret
              readOnly: true
            - name: mongo-keyfile
              mountPath: /workdir
      volumes:
        - name: mongo-keyfile
          emptyDir: {}
        - name: mongo-keyfile-secret
          secret:
            secretName: {{ include "cars-project.fullname" . }}-db-connection
            items:
              - key: MONGO_RS_KEY
                path: keyfile
---
apiVersion: v1
kind: Service
metadata:
  name: mongo-arbiter
  labels:
    app: mongo-arbiter
spec:
  selector:
    app: mongo-arbiter
  ports:
    - port: 27017
      targetPort: 27017
      protocol: TCP
      name: mongo
---
apiVersion: batch/v1
kind: Job
metadata:
  name: mongo-rs-init
  labels:
    app: mongo-rs
  annotations:
    "helm.sh/hook": post-install,post-upgrade
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  backoffLimit: 6
  template:
    metadata:
      labels:
        app: mongo-rs-init
    spec:
      restartPolicy: OnFailure
      containers:
        - name: mongo-rs-init
          image: docker.io/library/mongo:6.0@sha256:8b6d8f5bbedb25cb73517b65cf99f13aeb75ad5b157a56c479287a840bbad3ac
          command:
            - /bin/bash
            - -ec
            - |
              until mongosh --host mongo-rs-0.{{ .Values.mongoServiceName }}.{{ .Release.Namespace }}.svc.cluster.local -u "$MONGO_ROOT_USERNAME" -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin --eval 'db.adminCommand({ ping: 1 })'; do
                sleep 10
              done
              until mongosh --host mongo-rs-0.{{ .Values.mongoServiceName }}.{{ .Release.Namespace }}.svc.cluster.local -u "$MONGO_ROOT_USERNAME" -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin --quiet <<'JS'
              const desiredConfig = {
                _id: "{{ .Values.mongoReplicaSetName }}",
                members: [
                  { _id: 0, host: "mongo-rs-0.{{ .Values.mongoServiceName }}.{{ .Release.Namespace }}.svc.cluster.local:27017", priority: 2 },
                  { _id: 1, host: "mongo-rs-1.{{ .Values.mongoServiceName }}.{{ .Release.Namespace }}.svc.cluster.local:27017", priority: 1 },
                  { _id: 2, host: "mongo-arbiter.{{ .Release.Namespace }}.svc.cluster.local:27017", arbiterOnly: true }
                ]
              };
              function hasPrimary(status) {
                return Array.isArray(status.members) && status.members.some((member) => member.stateStr === "PRIMARY");
              }
              try {
                const status = rs.status();
                if (hasPrimary(status)) {
                  quit(0);
                }
              } catch (statusError) {
                try {
                  rs.initiate(desiredConfig);
                } catch (initError) {
                  const msg = String(initError && (initError.errmsg || initError.message || initError));
                  if (!msg.includes("already initialized")) {
                    print(msg);
                  }
                }
              }
              try {
                const status = rs.status();
                if (hasPrimary(status)) {
                  quit(0);
                }
                printjson(status);
              } catch (retryError) {
                print(String(retryError && (retryError.errmsg || retryError.message || retryError)));
              }
              quit(1);
              JS
                sleep 5
              done
          env:
            - name: MONGO_ROOT_USERNAME
              valueFrom:
                secretKeyRef:
                  name: {{ include "cars-project.fullname" . }}-db-connection
                  key: MONGO_ROOT_USERNAME
            - name: MONGO_ROOT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ include "cars-project.fullname" . }}-db-connection
                  key: MONGO_ROOT_PASSWORD
{{- end }}
`
    );

    await logStep(`Helm chart generated at ${helmDir}`);

    // 15) Deploy with Helm
    const helmTimeout = process.env.CARS_HELM_TIMEOUT || '20m';
    await runCommand('helm', [
      'upgrade', '--install', helmReleaseName, helmDir,
      '--namespace', namespace, '--atomic', '--timeout', helmTimeout,
    ], { stdio: 'inherit', timeoutMs: 45 * 60 * 1000 });
    await logStep(`Helm release ${helmReleaseName} deployed for project ${project.project_uuid}`);

    // 16) Wait for the main deployment to roll out
    await runCommand('kubectl', [
      'rollout', 'status', `deployment/${helmReleaseName}-deployment`,
      '-n', namespace, `--timeout=${helmTimeout}`,
    ], { stdio: 'inherit', timeoutMs: 45 * 60 * 1000 });
    await logStep(`Project ${project.project_uuid}, release ${deploymentId} rolled out successfully.`);

    // The release itself is the source of truth for the capabilities the node
    // advertises. Only publish registry changes after the new backend is ready.
    let deployedCapabilities = { topicManagers: [] as string[], lookupServices: [] as string[] };
    if (backendEnabled) {
      const internalBackendUrl = `http://${helmReleaseName}-service.${namespace}.svc.cluster.local:8080`;
      deployedCapabilities = await inspectProjectCapabilities(internalBackendUrl);
      const expectedTopics = Object.keys(deploymentInfo.topicManagers || {});
      const expectedServices = Object.keys(deploymentInfo.lookupServices || {});
      const missingTopics = expectedTopics.filter(name => !deployedCapabilities.topicManagers.includes(name));
      const missingServices = expectedServices.filter(name => !deployedCapabilities.lookupServices.includes(name));
      if (missingTopics.length || missingServices.length) {
        throw new Error(`Deployed capability verification failed: missing topics=${missingTopics.join(',')} services=${missingServices.join(',')}`);
      }
    }
    await replaceProjectCapabilities(db, {
      projectId: project.id,
      deployId: deploy.id,
      network: projectNetwork,
      domain: `https://${valuesObj.ingressHostBackend}`,
      capabilities: deployedCapabilities,
    });
    await logStep(`CARS node advertisement registry updated with ${deployedCapabilities.topicManagers.length} topics and ${deployedCapabilities.lookupServices.length} lookup services.`);

    // Log final URLs
    if (frontendEnabled) {
      await logStep(`Frontend URL: ${valuesObj.ingressHostFrontend}`);
    }
    if (backendEnabled) {
      await logStep(`Backend URL: ${valuesObj.ingressHostBackend}`);
    }

    let completionMessage = 'Deployment completed successfully';
    if (frontendEnabled) completionMessage += ` frontend=${valuesObj.ingressHostFrontend}`;
    if (backendEnabled) completionMessage += ` backend=${valuesObj.ingressHostBackend}`;
    if (frontendEnabled && project.frontend_custom_domain) {
      completionMessage += ` frontendCustom=${project.frontend_custom_domain}`;
    }
    if (backendEnabled && project.backend_custom_domain) {
      completionMessage += ` backendCustom=${project.backend_custom_domain}`;
    }
    await logStep(completionMessage);
    await db('deploys').where({ id: deploy.id }).update({
      status: 'succeeded',
      error_message: null,
      completed_at: db.fn.now(),
    });
  } catch (error: any) {
    const publicMessage = 'CARS could not process this deployment';
    const errorMessage = String(error?.message || 'Unknown deployment failure').slice(0, 2000);
    if (deploy && project) {
      await db('deploys').where({ id: deploy.id }).update({
        status: claimed ? 'failed' : deploy.status,
        error_message: claimed ? errorMessage : deploy.error_message,
        completed_at: claimed ? db.fn.now() : deploy.completed_at,
      }).catch(() => undefined);
      await db('logs').insert({
        project_id: project.id,
        deploy_id: deploy.id,
        message: `Deployment failed: ${errorMessage}`
      }).catch(() => undefined);
      logger.error({
        deploymentId,
        projectId: project.project_uuid,
        error: errorMessage,
        alert: 'cars.deployment.failed',
      }, 'CARS deployment failed');

      // Attempt to email project admins about the failure
      try {
        const admins = await db('project_admins')
          .join('users', 'users.identity_key', 'project_admins.identity_key')
          .where({ 'project_admins.project_id': project.id })
          .select('users.email', 'users.identity_key');
        const emails = admins.map((a: any) => a.email);

        const subject = `Deployment Failure for Project: ${project.name}`;
        const body = `Hello,

A deployment for project "${project.name}" (ID: ${project.project_uuid}) has failed.
Deployment ID: ${deploy.deployment_uuid}

Error Details:
${errorMessage}

Originated by: ${(req as any).user?.identity_key} (${(req as any).user?.email})

Please check the logs for more details.

Regards,
CARS System`;

        await sendDeploymentFailureEmail(emails, project, body, subject);
      } catch (emailError: any) {
        logger.error({
          deploymentId,
          projectId: project.project_uuid,
          error: emailError?.message || 'Unknown deployment notification failure',
          alert: 'cars.deployment.failure_notification_failed',
        }, 'CARS could not send a deployment failure notification');
      }
    }

    if (!res.headersSent) {
      const status = errorMessage.includes('exceeds') ? 413 : 500;
      res.status(status).json({
        error: publicMessage,
        code: 'CARS_DEPLOYMENT_FAILED',
        requestId: (req as any).requestId,
      });
    }
  } finally {
    if (claimed) {
      if (workspaceRoot) await fs.remove(workspaceRoot).catch(() => undefined);
      await db('deploys').where({ id: deploy?.id }).update({ file_path: null }).catch(() => undefined);
    }
  }
};
