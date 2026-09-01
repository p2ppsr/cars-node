import { CronJob } from 'cron';
import { checkAndFundProjectKeys } from './utils/wallet';
import logger from './logger';
import type { Knex } from 'knex';
import { billProjects } from './utils/billing';
import type { ProjectWallets } from './utils/wallet';

export function startCronJobs(db: Knex, wallets: ProjectWallets) {
    // Check project keys every 5 minutes
    new CronJob(
        '*/5 * * * *',
        async () => {
            try {
                await runSingletonCron(db, async () => {
                    logger.info('Running singleton CARS cron jobs');
                    await reconcileStaleDeployments(db);
                    try {
                        await checkAndFundProjectKeys(db, wallets);
                    } catch (error) {
                        logger.error({ error, alert: 'cars.cron.project_keys.failed' }, 'Error in project keys cron job');
                    }
                    try {
                        await billProjects();
                    } catch (error) {
                        logger.error({ error, alert: 'cars.cron.billing.failed' }, 'Error in project billing cron job');
                    }
                });
            } catch (error) {
                logger.error({ error, alert: 'cars.cron.singleton.failed' }, 'CARS singleton cron execution failed');
            }
        },
        null,
        true
    );

    logger.info('Cron jobs started');
}

export async function reconcileStaleDeployments(db: Knex): Promise<void> {
    const configuredTtl = Number.parseInt(process.env.CARS_UPLOAD_URL_TTL_MS || '', 10);
    const uploadTtlMs = Number.isSafeInteger(configuredTtl) && configuredTtl >= 60_000 && configuredTtl <= 24 * 60 * 60 * 1000
        ? configuredTtl
        : 60 * 60 * 1000;
    const pendingCutoff = new Date(Date.now() - uploadTtlMs);
    await db('deploys')
        .where({ status: 'pending' })
        .where('created_at', '<', pendingCutoff)
        .update({
            status: 'expired',
            error_message: 'Upload URL expired before use',
            completed_at: db.fn.now(),
        });

    const processingCutoff = new Date(Date.now() - 8 * 60 * 60 * 1000);
    const stale = await db('deploys')
        .whereIn('status', ['uploading', 'processing'])
        .where('accepted_at', '<', processingCutoff)
        .select('id', 'project_id', 'deployment_uuid');
    if (stale.length === 0) return;
    const ids = stale.map((deploy: any) => deploy.id);
    await db.transaction(async trx => {
        await trx('deploys').whereIn('id', ids).update({
            status: 'failed',
            error_message: 'Deployment processing exceeded the eight-hour recovery window',
            completed_at: trx.fn.now(),
            file_path: null,
        });
        await trx('logs').insert(stale.map((deploy: any) => ({
            project_id: deploy.project_id,
            deploy_id: deploy.id,
            message: 'Deployment failed: processing exceeded the eight-hour recovery window',
        })));
    });
    logger.error({
        deployments: stale.slice(0, 100).map((deploy: any) => deploy.deployment_uuid),
        count: stale.length,
        alert: 'cars.deployment.stale_reconciled',
    }, 'CARS reconciled deployments left in a stale processing state');
}

export async function runSingletonCron(db: Knex, handler: () => Promise<void>): Promise<boolean> {
    return db.transaction(async trx => {
        const [rows] = await trx.raw("SELECT GET_LOCK('cars.cron.five_minute.v1', 0) AS acquired");
        const acquired = Number((rows as any)?.[0]?.acquired || 0) === 1;
        if (!acquired) {
            logger.info('Skipping CARS cron run because another replica owns the advisory lock');
            return false;
        }
        try {
            await handler();
            return true;
        } finally {
            await trx.raw("SELECT RELEASE_LOCK('cars.cron.five_minute.v1')");
        }
    });
}
