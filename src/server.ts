import express from 'express';
import db from './db';
import logger from './logger';
import { createAuthMiddleware } from '@bsv/auth-express-middleware';
import { createPaymentMiddleware } from '@bsv/payment-express-middleware';
import bodyParser from 'body-parser';
import routes from './routes';
import upload from './routes/upload';
import publicRoute from './routes/public';
import globalEviction from './routes/globalEviction';
import { initCluster } from './init-cluster';
import { startCronJobs } from './cron';
import timeout from 'connect-timeout';
import { makeWallet } from './utils/wallet';
import { collectSystemHealth } from './health';

const port = parseInt(process.env.CARS_NODE_PORT || '7777', 10);
const uploadTimeout = process.env.CARS_UPLOAD_TIMEOUT || '6h';
const jsonBodyLimit = process.env.CARS_JSON_BODY_LIMIT || '2mb';
const maxPaymentChunkSats = parseInt(process.env.CARS_MAX_PAYMENT_CHUNK_SATS || '10000', 10);
const MAINNET_PRIVATE_KEY = process.env.MAINNET_PRIVATE_KEY;
const TESTNET_PRIVATE_KEY = process.env.TESTNET_PRIVATE_KEY;
const INIT_K3S = process.env.INIT_K3S;

if (!MAINNET_PRIVATE_KEY || !TESTNET_PRIVATE_KEY) {
    throw new Error('Missing CARS node testnet or mainnet private keys on startup.');
}
if (!process.env.TAAL_API_KEY_MAIN || !process.env.TAAL_API_KEY_TEST) {
    throw new Error('TAAL API keys not configured');
}

function haltOnTimedout(req, res, next) {
    if (!req.timedout) next()
}

function sanitizeForLog(value: any): any {
    if (Array.isArray(value)) {
        return value.map(sanitizeForLog);
    }
    if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
            if (/key|token|secret|signature|authorization|password/i.test(key)) {
                return [key, '[redacted]'];
            }
            return [key, sanitizeForLog(entry)];
        }));
    }
    return value;
}

function topUpAmountFromRequest(req: any) {
    if (!req.path.startsWith('/api/v1/project/') || !req.path.endsWith('/pay')) {
        return 0;
    }
    const amount = Number(req.body?.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > maxPaymentChunkSats) {
        logger.warn({ path: req.path, amount, maxPaymentChunkSats }, 'Rejecting invalid CARS top-up payment amount before charging');
        return 0;
    }
    return amount;
}

async function main() {
    let migrationsComplete = false;

    // Run migrations
    logger.info('Running database migrations...');
    await db.migrate.latest();
    logger.info('Migrations completed.');
    migrationsComplete = true;

    // We have two wallets: one on mainnet and one on testnet
    const mainnetWallet = await makeWallet('main', MAINNET_PRIVATE_KEY!)
    const testnetWallet = await makeWallet('test', TESTNET_PRIVATE_KEY!)

    if (INIT_K3S) {
        await initCluster();
    }
    startCronJobs(db, mainnetWallet, testnetWallet);

    const app = express();
    app.set('trust proxy', true);
    const isUploadRequest = (req) => req.path.startsWith('/api/v1/upload/');

    app.use((req, res, next) => {
        if (isUploadRequest(req)) {
            return next();
        }
        return bodyParser.json({ limit: jsonBodyLimit })(req, res, next);
    });
    app.use((req, res, next) => {
        if (isUploadRequest(req)) {
            return next();
        }
        return bodyParser.raw({ type: 'application/octet-stream', limit: '1gb' })(req, res, next);
    });

    // CORS
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*')
        res.header('Access-Control-Allow-Headers', '*')
        res.header('Access-Control-Allow-Methods', '*')
        res.header('Access-Control-Expose-Headers', '*')
        if (req.method === 'OPTIONS') {
            return res.sendStatus(200)
        }
        next()
    });

    // Attach wallet and db to request context if needed
    app.use((req, res, next) => {
        (req as any).db = db;
        (req as any).mainnetWallet = mainnetWallet;
        (req as any).testnetWallet = testnetWallet;
        next();
    });

    app.get('/health/live', async (_req, res) => {
        const report = await collectSystemHealth(db, {
            mainnetWalletReady: true,
            testnetWalletReady: true,
            migrationsComplete
        });
        res.status(report.live ? 200 : 503).json(report);
    });

    app.get('/health/ready', async (_req, res) => {
        const report = await collectSystemHealth(db, {
            mainnetWalletReady: true,
            testnetWalletReady: true,
            migrationsComplete
        });
        res.status(report.ready ? 200 : 503).json(report);
    });

    app.get('/health', async (_req, res) => {
        const report = await collectSystemHealth(db, {
            mainnetWalletReady: true,
            testnetWalletReady: true,
            migrationsComplete
        });
        res.status(report.ready ? 200 : 503).json(report);
    });

    // Upload uses signed URLs, so is excluded from Authrite. Also, they are not logged for performance reasons (they are large).
    app.post('/api/v1/upload/:deploymentId/:signature', timeout(uploadTimeout), haltOnTimedout, upload);

    // Public queries are also not authenticated
    app.get('/api/v1/public', publicRoute)

    // Global outpoint eviction endpoint also not authenticated
    app.post('/api/v1/evict-globally', globalEviction)

    // Logging middleware
    app.use((req, res, next) => {
        const startTime = Date.now();

        // Log incoming request details
        const requestId = (req.headers['x-request-id'] as string) || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        (req as any).requestId = requestId;
        res.setHeader('x-request-id', requestId);

        logger.info({ requestId, method: req.method, url: req.url, remoteAddress: req.ip }, 'Incoming Request');

        // Handle request body
        if (req.body && Object.keys(req.body).length > 0) {
            let bodyString;
            if (typeof req.body === 'object') {
                bodyString = JSON.stringify(req.body, null, 2);
                if (bodyString.length > 800) {
                    logger.info({ length: bodyString.length }, 'Request Body (object, truncated)')
                } else {
                    logger.info(sanitizeForLog(req.body), 'Request Body')
                }
            } else if (Buffer.isBuffer(req.body)) {
                bodyString = req.body.toString('utf8');
                logger.info({ length: bodyString.length }, 'Request Body (raw, truncated)')
            }
        }

        // Intercept the res.send method
        const originalSend = res.send;
        let responseBody: any;

        res.send = function (body?: any): any {
            responseBody = body;
            return originalSend.call(this, body);
        };

        // Log outgoing response details after the response is finished
        res.on('finish', () => {
            const duration = Date.now() - startTime;
            logger.info({ requestId, method: req.method, url: req.url, statusCode: res.statusCode, duration }, 'Outgoing Response')

            // Handle response body
            if (responseBody) {
                let bodyString;
                if (typeof responseBody === 'object') {
                    bodyString = JSON.stringify(responseBody, null, 2);
                    if (bodyString.length > 800) {
                        logger.info({ length: bodyString.length }, 'Response Body (object, truncated)')
                    } else {
                        logger.info(sanitizeForLog(responseBody), 'Response Body')
                    }
                } else if (Buffer.isBuffer(responseBody)) {
                    bodyString = responseBody.toString('utf8');
                    logger.info({ length: bodyString.length }, 'Response Body (raw, truncated)')
                } else if (typeof responseBody === 'string') {
                    bodyString = responseBody
                    if (bodyString.length > 800) {
                        logger.info({ length: bodyString.length }, 'Response Body (string, truncated)')
                    } else {
                        logger.info({ body: responseBody }, 'Response Body')
                    }
                }
            }
        });

        next();
    });

    // Authrite middleware
    app.use(createAuthMiddleware({
        wallet: mainnetWallet,
        onCertificatesReceived: async (identityKey, certs) => {
            try {
                if (
                    certs.length === 1 &&
                    typeof certs[0].decryptedFields!.email === 'string'
                    && certs[0].certifier === '02cf6cdf466951d8dfc9e7c9367511d0007ed6fba35ed42d425cc412fd6cfd4a17' &&
                    certs[0].type === 'exOl3KM0dIJ04EW5pZgbZmPag6MdJXd3/a1enmUU/BA='
                ) {
                    await db('users').where('identity_key', '=', identityKey).update({
                        email: certs[0].decryptedFields!.email
                    })
                }
            } catch (e) {
                console.error('Error associating certificate with user', e)
            }
        },
        // certificatesToRequest: {
        //     types: {
        //         'exOl3KM0dIJ04EW5pZgbZmPag6MdJXd3/a1enmUU/BA=': ['email']
        //     },
        //     certifiers: ['02cf6cdf466951d8dfc9e7c9367511d0007ed6fba35ed42d425cc412fd6cfd4a17']
        // }
    }));

    // Payment middleware charges capped top-up chunks only. Larger balance fills are split by the CLI.
    app.use(createPaymentMiddleware({
        wallet: mainnetWallet,
        calculateRequestPrice: (req: any) => {
            return topUpAmountFromRequest(req);
        }
    }))

    app.use('/api/v1', routes);

    app.listen(port, () => {
        logger.info(`CARS Node listening on port ${port}`);
    });
}

main().catch(err => {
    logger.error(err, 'Error on startup');
    process.exit(1);
});
