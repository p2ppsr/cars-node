import axios from 'axios';
import type { Knex } from 'knex';
import type { ProjectNetwork } from '../network';

export type AdvertisementProtocol = 'SHIP' | 'SLAP';

export interface ProjectCapabilities {
  topicManagers: string[];
  lookupServices: string[];
}

const DISCOVERY_TOPICS = new Set(['tm_ship', 'tm_slap']);
const DISCOVERY_SERVICES = new Set(['ls_ship', 'ls_slap']);

export function applicationCapabilities(
  topicManagers: Iterable<string>,
  lookupServices: Iterable<string>,
): ProjectCapabilities {
  return {
    topicManagers: [...new Set(topicManagers)].filter(name => !DISCOVERY_TOPICS.has(name)).sort(),
    lookupServices: [...new Set(lookupServices)].filter(name => !DISCOVERY_SERVICES.has(name)).sort(),
  };
}

export async function inspectProjectCapabilities(baseUrl: string): Promise<ProjectCapabilities> {
  const [topics, services] = await Promise.all([
    axios.get(`${baseUrl}/listTopicManagers`, { timeout: 30_000 }),
    axios.get(`${baseUrl}/listLookupServiceProviders`, { timeout: 30_000 }),
  ]);
  return applicationCapabilities(Object.keys(topics.data || {}), Object.keys(services.data || {}));
}

export async function replaceProjectCapabilities(
  db: Knex,
  options: {
    projectId: number;
    deployId?: number;
    network: ProjectNetwork;
    domain: string;
    capabilities: ProjectCapabilities;
  },
): Promise<void> {
  const rows = [
    ...options.capabilities.topicManagers.map(capability => ({
      project_id: options.projectId,
      deploy_id: options.deployId || null,
      network: options.network,
      protocol: 'SHIP' as const,
      domain: options.domain,
      capability,
      active: true,
    })),
    ...options.capabilities.lookupServices.map(capability => ({
      project_id: options.projectId,
      deploy_id: options.deployId || null,
      network: options.network,
      protocol: 'SLAP' as const,
      domain: options.domain,
      capability,
      active: true,
    })),
  ];

  await db.transaction(async trx => {
    await trx('cars_advertised_capabilities')
      .where({ project_id: options.projectId, active: true })
      .update({ active: false, updated_at: trx.fn.now() });

    for (const row of rows) {
      await trx('cars_advertised_capabilities')
        .insert(row)
        .onConflict(['project_id', 'protocol', 'domain', 'capability'])
        .merge({
          deploy_id: row.deploy_id,
          network: row.network,
          active: true,
          updated_at: trx.fn.now(),
        });
    }
  });
}
