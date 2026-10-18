import OverlayExpress from '@bsv/overlay-express';
import db from './db';
import logger from './logger';
import { normalizeProjectNetwork, projectNetworkToOverlayNetwork, type ProjectNetwork } from './network';
import { PassiveAdvertiser } from './advertisements/passive-advertiser';
import { AdvertisementReconciler, type ReconcileReport } from './advertisements/reconciler';
import { installDiscoveryDenylist } from './discovery-denylist';

import { MySqlLeaderLease } from './advertisements/leader';
import { MaintenanceWorker } from './maintenance-worker';
import { advisoryDb } from './advisory-db';
import { backgroundWorkPaused } from './background-maintenance';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  backgroundWorkPaused(); // Reject malformed maintenance configuration before starting work.
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
    // OverlayExpress derives the discovery Mongo namespace from the service
    // name. Use the established CARS namespace so the singleton controller
    // owns the same CARS_lookup_services state as the project fleet did.
    'CARS',
    privateKey,
    process.env.ADVERTISEMENT_CONTROLLER_FQDN || 'cars-advertisements.cars-operator-system.svc.cluster.local',
    process.env.ADVERTISEMENT_ADMIN_BEARER_TOKEN,
  );
  server.configurePort(port);
  server.configureNetwork(overlayNetwork);
  if (overlayNetwork === 'main' && process.env.TAAL_API_KEY_MAIN) {
    server.configureArcApiKey(process.env.TAAL_API_KEY_MAIN);
  } else if (overlayNetwork === 'test' && process.env.TAAL_API_KEY_TEST) {
    server.configureArcApiKey(process.env.TAAL_API_KEY_TEST);
  } else if (overlayNetwork === 'ttn' && process.env.TTN_ARCADE_URL) {
    server.configureArcade(process.env.TTN_ARCADE_URL, {
      apiKey: process.env.TTN_ARCADE_API_KEY,
      deploymentId: process.env.TTN_ARCADE_DEPLOYMENT_ID,
      chaintracksApiPrefix: process.env.TTN_CHAINTRACKS_API_PREFIX,
    });
  }
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
  installDiscoveryDenylist(undefined, reconciler.identityKey);
  const leader = new MySqlLeaderLease(advisoryDb, `cars-advertisement-controller:${network}`);
  let lastReconcile: ReconcileReport | undefined;
  let lastGaspAt: string | undefined;
  let lastGaspError: string | undefined;

  let nextGaspAt = Date.now() + gaspIntervalMs;
  const worker = new MaintenanceWorker(async () => {
    try {
      if (backgroundWorkPaused()) { await leader.release(); return; }
      if (await leader.acquire()) {
        // stop() may arrive while the asynchronous lock check is in flight.
        if (worker.state.stopping) return;
        if (reconciliationEnabled) lastReconcile = await reconciler.reconcile();
        if (!worker.state.stopping && Date.now() >= nextGaspAt) {
          try {
            await server.engine!.startGASPSync();
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
  }, reconcileIntervalMs);

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
      maintenance: { ...worker.state, paused: backgroundWorkPaused(), nextGaspAt: new Date(nextGaspAt).toISOString() },
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
    await worker.stop();
    await leader.release().catch(error => logger.error({ error }, 'Failed to release controller leader lock'));
    await server.close();
    if (advisoryDb !== db) await advisoryDb.destroy();
    await db.destroy();
  };
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.once('SIGINT', () => void stop('SIGINT'));

  // The shared discovery state is warm. The interruptible worker preserves
  // the six-hour GASP cadence and finishes in-flight work before releasing its
  // leadership or closing database/HTTP resources during shutdown.
  await worker.run();
}

main().catch(error => {
  logger.fatal({ error }, 'CARS advertisement controller failed to start');
  // A second replica can briefly collide with Overlay Engine's migration lock.
  // Exit so Kubernetes retries it after the elected starter has released the
  // lock instead of leaving a permanently unready process with open DB clients.
  process.exit(1);
});
