import { execFileSync } from 'child_process';
import db from '../db';
import logger from '../logger';
import { normalizeProjectNetwork } from '../network';
import { inspectProjectCapabilities, replaceProjectCapabilities } from '../advertisements/registry';

interface KubernetesDeployment {
  metadata?: { namespace?: string; name?: string };
  spec?: { template?: { spec?: { containers?: Array<{ name?: string }> } } };
}

async function main() {
  await db.migrate.latest();
  const raw = execFileSync('kubectl', ['get', 'deployments', '-A', '-o', 'json'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  const deployments = (JSON.parse(raw).items || []) as KubernetesDeployment[];
  const backendNamespaces = deployments
    .filter(item => item.metadata?.namespace?.startsWith('cars-project-'))
    .filter(item => item.spec?.template?.spec?.containers?.some(container => container.name === 'backend'))
    .map(item => item.metadata!.namespace!)
    .sort();

  let registered = 0;
  for (const namespace of backendNamespaces) {
    const projectUuid = namespace.slice('cars-project-'.length);
    const project = await db('projects').where({ project_uuid: projectUuid }).first();
    if (!project) throw new Error(`No CARS project row for ${namespace}`);
    const release = `cars-project-${projectUuid.slice(0, 24)}`;
    const baseUrl = `http://${release}-service.${namespace}.svc.cluster.local:8080`;
    const capabilities = await inspectProjectCapabilities(baseUrl);
    await replaceProjectCapabilities(db, {
      projectId: project.id,
      network: normalizeProjectNetwork(project.network),
      domain: `https://backend.${projectUuid}.${process.env.PROJECT_DEPLOYMENT_DNS_NAME}`,
      capabilities,
    });
    registered += capabilities.topicManagers.length + capabilities.lookupServices.length;
    logger.info({ projectUuid, capabilities }, 'Seeded project advertisement registry');
  }
  logger.info({ projects: backendNamespaces.length, capabilities: registered }, 'Advertisement registry seed complete');
  await db.destroy();
}

main().catch(async error => {
  logger.fatal({ error }, 'Failed to seed advertisement registry');
  await db.destroy().catch(() => undefined);
  process.exitCode = 1;
});
