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
            await runSingletonCron(db, async () => {
                logger.info('Running singleton CARS cron jobs');
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
        },
        null,
        true
    );

    logger.info('Cron jobs started');
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
