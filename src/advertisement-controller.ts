import OverlayExpress from '@bsv/overlay-express';
import type { Knex } from 'knex';
import db from './db';
import logger from './logger';
import { normalizeProjectNetwork, projectNetworkToOverlayNetwork, type ProjectNetwork } from './network';
import { PassiveAdvertiser } from './advertisements/passive-advertiser';
import { AdvertisementReconciler, type ReconcileReport } from './advertisements/reconciler';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class MySqlLeaderLease {
  private connection: any;
  isLeader = false;

  constructor(private readonly knex: Knex, private readonly lockName: string) {}

  async acquire(): Promise<boolean> {
    if (this.connection) return this.isLeader;
    const connection = await this.knex.client.acquireConnection();
    try {
      const [rows] = await connection.query('SELECT GET_LOCK(?, 0) AS acquired', [this.lockName]);
      this.isLeader = Number(rows?.[0]?.acquired) === 1;
      if (!this.isLeader) {
        await this.knex.client.releaseConnection(connection);
        return false;
      }
      this.connection = connection;
      return true;
    } catch (error) {
      await this.knex.client.releaseConnection(connection);
      throw error;
    }
  }

  async release(): Promise<void> {
    if (!this.connection) return;
    try {
      await this.connection.query('SELECT RELEASE_LOCK(?)', [this.lockName]);
    } finally {
      await this.knex.client.releaseConnection(this.connection);
      this.connection = undefined;
      this.isLeader = false;
    }
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const privateKey = required('CARS_ADVERTISEMENT_PRIVATE_KEY');
  if (!/^[0-9a-f]{64}$/.test(privateKey)) {
    throw new Error('CARS_ADVERTISEMENT_PRIVATE_KEY must be 64 lowercase hexadecimal characters');
  }
  const network = normalizeProjectNetwork(process.env.ADVERTISEMENT_NETWORK || 'mainnet');
  const overlayNetwork = projectNetworkToOverlayNetwork(network);
  const port = Number.parseInt(process.env.ADVERTISEMENT_CONTROLLER_PORT || '8081', 10);
  const reconcileIntervalMs = Number.parseInt(process.env.ADVERTISEMENT_RECONCILE_INTERVAL_MS || '300000', 10);
  const gaspIntervalMs = Number.parseInt(process.env.ADVERTISEMENT_GASP_INTERVAL_MS || '21600000', 10);
  const reconciliationEnabled = process.env.ADVERTISEMENT_RECONCILE_ENABLED !== 'false';

  logger.info({ network }, 'Running CARS database migrations for advertisement controller');
  await db.migrate.latest();

  const server = new OverlayExpress(
    'CARS Advertisement Controller',
    privateKey,
    process.env.ADVERTISEMENT_CONTROLLER_FQDN || 'cars-advertisements.cars-operator-system.svc.cluster.local',
    process.env.ADVERTISEMENT_ADMIN_BEARER_TOKEN,
  );
  server.configurePort(port);
  server.configureNetwork(overlayNetwork);
  await server.configureKnex(required('ADVERTISEMENT_KNEX_URL'));
  await server.configureMongo(required('ADVERTISEMENT_MONGO_URL'));
  server.configureEnableGASPSync(true);
  server.configureVerboseRequestLogging(false);
  server.configureEngineParams({
    advertiser: new PassiveAdvertiser(),
    suppressDefaultSyncAdvertisements: true,
    throwOnBroadcastFailure: false,
    syncConfiguration: {
      tm_ship: 'SHIP',
      tm_slap: 'SHIP',
    },
    logPrefix: '[CARS ADVERTISEMENT ENGINE] ',
  });
  await server.configureEngine(true);
  if (!server.engine) throw new Error('Advertisement overlay engine was not configured');

  const reconciler = new AdvertisementReconciler(db, server.engine, privateKey, network);
  const leader = new MySqlLeaderLease(db, `cars-advertisement-controller:${network}`);
  let lastReconcile: ReconcileReport | undefined;
  let lastGaspAt: string | undefined;
  let lastGaspError: string | undefined;

  server.configureHealth({
    contextProvider: async () => ({
      serviceType: 'cars-advertisement-controller',
      network,
      identityKey: reconciler.identityKey,
      reconciliationEnabled,
      leader: leader.isLeader,
      lastReconcile,
      lastGaspAt,
      lastGaspError,
    }),
  });

  // configureEngine needed GASP enabled to build the sync configuration. Avoid
  // blocking listen on a full discovery sync; the elected replica owns it.
  server.enableGASPSync = false;
  await server.start();

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Stopping CARS advertisement controller');
    await leader.release().catch(error => logger.error({ error }, 'Failed to release controller leader lock'));
    await server.close();
    await db.destroy();
  };
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.once('SIGINT', () => void stop('SIGINT'));

  let nextGaspAt = 0;
  while (!stopping) {
    try {
      if (await leader.acquire()) {
        if (reconciliationEnabled) {
          lastReconcile = await reconciler.reconcile();
        }
        if (Date.now() >= nextGaspAt) {
          try {
            await server.engine.startGASPSync();
            lastGaspAt = new Date().toISOString();
            lastGaspError = undefined;
          } catch (error: any) {
            lastGaspError = error?.message || String(error);
            logger.error({ error }, 'Advertisement controller GASP sync failed');
          }
          nextGaspAt = Date.now() + gaspIntervalMs;
        }
      }
    } catch (error) {
      logger.error({ error }, 'Advertisement controller loop failed');
      await leader.release().catch(() => undefined);
    }
    await sleep(reconcileIntervalMs);
  }
}

main().catch(error => {
  logger.fatal({ error }, 'CARS advertisement controller failed to start');
  process.exitCode = 1;
});
