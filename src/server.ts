import 'express-async-errors';
import express from 'express';
import crypto from 'node:crypto';
import db from './db';
import logger from './logger';
import { createAuthMiddleware } from '@bsv/auth-express-middleware';
import { createPaymentMiddleware } from '@bsv/payment-express-middleware';
import bodyParser from 'body-parser';
import routes from './routes';
import upload from './routes/upload';
import publicRoute from './routes/public';
import globalEviction from './routes/globalEviction';
import { startCronJobs } from './cron';
import timeout from 'connect-timeout';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { makeWallet } from './utils/wallet';
import { collectSystemHealth } from './health';
import { KnexSessionManager } from '@bsv/wallet-toolbox';
import type { ProjectWallets } from './utils/wallet';
import { disableRequestTimeout } from './http-server';
import { KnexPaymentReplayStore } from './payment-replay';

function positiveInteger(name: string, fallback: number, maximum: number): number {
    const value = Number.parseInt(process.env[name] || String(fallback), 10);
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new Error(`${name} must be an integer between 1 and ${maximum}`);
    }
    return value;
}

const port = positiveInteger('CARS_NODE_PORT', 7777, 65535);
const uploadTimeout = process.env.CARS_UPLOAD_TIMEOUT || '6h';
const jsonBodyLimit = process.env.CARS_JSON_BODY_LIMIT || '2mb';
const maxPaymentChunkSats = positiveInteger('CARS_MAX_PAYMENT_CHUNK_SATS', 10000, 100_000_000);
const MAINNET_PRIVATE_KEY = process.env.MAINNET_PRIVATE_KEY;
const TESTNET_PRIVATE_KEY = process.env.TESTNET_PRIVATE_KEY;
const TTN_PRIVATE_KEY = process.env.TTN_PRIVATE_KEY;

if (!MAINNET_PRIVATE_KEY || !TESTNET_PRIVATE_KEY) {
    throw new Error('Missing CARS node testnet or mainnet private keys on startup.');
}
if (!process.env.TAAL_API_KEY_MAIN || !process.env.TAAL_API_KEY_TEST) {
    throw new Error('TAAL API keys not configured');
}
if (process.env.NODE_ENV === 'production' && !/^https:\/\//.test(process.env.CARS_NODE_SERVER_BASEURL || '')) {
    throw new Error('CARS_NODE_SERVER_BASEURL must use HTTPS in production');
}

function haltOnTimedout(req, res, next) {
    if (!req.timedout) next()
}

function publicHealth(report: any) {
    return {
        status: report.status,
        live: report.live,
        ready: report.ready,
        checks: (report.checks || []).map(check => ({
            name: check.name,
            status: check.status,
            critical: check.critical,
            readinessCritical: check.readinessCritical,
            livenessCritical: check.livenessCritical,
            durationMs: check.durationMs,
        })),
    };
}

function requestId(req: any): string {
    const supplied = req.headers['x-request-id'];
    if (typeof supplied === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(supplied)) return supplied;
    return crypto.randomUUID();
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
    if (typeof value === 'string') {
        return value.replace(
            /(\/api\/v1\/upload\/[a-f0-9]{32}\/)[a-f0-9]{64,512}/gi,
            '$1[redacted]',
        );
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
    let healthCache: { expiresAt: number; report: any } | undefined;
    let healthInFlight: Promise<any> | undefined;
    let lastHealthAlert = { fingerprint: '', emittedAt: 0 };

    // Run migrations
    logger.info('Running database migrations...');
    await db.migrate.latest();
    logger.info('Migrations completed.');
    migrationsComplete = true;

    // Mainnet remains the authentication/payment wallet. Project funding uses
    // the wallet matching each project's configured network.
    const mainnetWallet = await makeWallet('main', MAINNET_PRIVATE_KEY!)
    const testnetWallet = await makeWallet('test', TESTNET_PRIVATE_KEY!)
    const ttnWallet = TTN_PRIVATE_KEY ? await makeWallet('ttn', TTN_PRIVATE_KEY) : undefined;
    const projectWallets: ProjectWallets = {
        mainnet: mainnetWallet,
        testnet: testnetWallet,
        ...(ttnWallet ? { teratestnet: ttnWallet } : {})
    };
    const authSessionManager = new KnexSessionManager(db);

    startCronJobs(db, projectWallets);

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 1);
    const isUploadRequest = (req) => req.path.startsWith('/api/v1/upload/');
    const configuredOrigins = new Set(
        String(process.env.CARS_ALLOWED_ORIGINS || '')
            .split(',')
            .map(value => value.trim())
            .filter(Boolean)
    );

    app.use(helmet());
    app.use((req, res, next) => {
        const id = requestId(req);
        (req as any).requestId = id;
        res.setHeader('x-request-id', id);
        res.setHeader('cache-control', 'no-store');
        next();
    });

    const apiLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 600,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: { error: 'Too many CARS API requests', code: 'CARS_RATE_LIMITED' },
    });
    const uploadLimiter = rateLimit({
        windowMs: 60 * 60 * 1000,
        limit: 30,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: { error: 'Too many deployment upload attempts', code: 'CARS_UPLOAD_RATE_LIMITED' },
    });
    const evictionLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 10,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: { error: 'Too many takedown requests', code: 'CARS_EVICTION_RATE_LIMITED' },
    });
    app.use('/api/v1', apiLimiter);

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
        return bodyParser.raw({ type: 'application/octet-stream', limit: '2mb' })(req, res, next);
    });

    // CORS
    app.use((req, res, next) => {
        const origin = req.header('origin');
        if (origin && configuredOrigins.size > 0 && !configuredOrigins.has(origin)) {
            return res.status(403).json({ error: 'Origin is not allowed' });
        }
        res.header('Access-Control-Allow-Origin', configuredOrigins.size > 0 && origin ? origin : '*')
        res.header('Vary', 'Origin')
        res.header('Access-Control-Allow-Headers', 'authorization, content-type, x-bsv-payment, x-request-id')
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.header('Access-Control-Expose-Headers', 'x-request-id, x-bsv-payment')
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
        (req as any).ttnWallet = ttnWallet;
        (req as any).projectWallets = projectWallets;
        next();
    });

    const getSystemHealth = async () => {
        if (healthCache && healthCache.expiresAt > Date.now()) return healthCache.report;
        if (healthInFlight) return healthInFlight;
        healthInFlight = collectSystemHealth(db, {
            mainnetWalletReady: true,
            testnetWalletReady: true,
            teratestnetWalletConfigured: TTN_PRIVATE_KEY != null,
            teratestnetWalletReady: ttnWallet != null,
            migrationsComplete
        }).then(report => {
            healthCache = { expiresAt: Date.now() + 15000, report };
            const failedChecks = report.checks
                .filter(check => check.status !== 'ok')
                .map(check => ({ name: check.name, status: check.status, message: check.message }));
            const fingerprint = JSON.stringify(failedChecks);
            if (failedChecks.length > 0 && (
                fingerprint !== lastHealthAlert.fingerprint || Date.now() - lastHealthAlert.emittedAt >= 5 * 60 * 1000
            )) {
                logger.error({
                    status: report.status,
                    ready: report.ready,
                    live: report.live,
                    failedChecks,
                    alert: 'cars.health.degraded',
                }, 'CARS health degraded');
                lastHealthAlert = { fingerprint, emittedAt: Date.now() };
            } else if (failedChecks.length === 0 && lastHealthAlert.fingerprint) {
                logger.info({ alert: 'cars.health.recovered' }, 'CARS health recovered');
                lastHealthAlert = { fingerprint: '', emittedAt: Date.now() };
            }
            return report;
        }).finally(() => {
            healthInFlight = undefined;
        });
        return healthInFlight;
    };

    app.get('/health/live', async (_req, res) => {
        const report = await getSystemHealth();
        res.status(report.live ? 200 : 503).json(publicHealth(report));
    });

    app.get('/health/ready', async (_req, res) => {
        const report = await getSystemHealth();
        res.status(report.ready ? 200 : 503).json(publicHealth(report));
    });

    app.get('/health', async (_req, res) => {
        const report = await getSystemHealth();
        res.status(report.ready ? 200 : 503).json(publicHealth(report));
    });

    // Upload uses signed URLs, so is excluded from Authrite. Also, they are not logged for performance reasons (they are large).
    app.post('/api/v1/upload/:deploymentId/:signature', uploadLimiter, timeout(uploadTimeout), haltOnTimedout, upload);

    // Public queries are also not authenticated
    app.get('/api/v1/public', publicRoute)

    // Global outpoint eviction endpoint also not authenticated
    app.post('/api/v1/evict-globally', evictionLimiter, globalEviction)

    // Logging middleware
    app.use((req, res, next) => {
        const startTime = Date.now();

        // Log incoming request details
        const requestId = (req as any).requestId;

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
        sessionManager: authSessionManager,
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
            } catch (error: any) {
                logger.error({
                    identityKey,
                    error: error?.message || 'Unknown certificate persistence failure',
                    alert: 'cars.auth.certificate_persistence_failed',
                }, 'Error associating certificate with user')
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
        replayStore: new KnexPaymentReplayStore(db),
        maxPaymentHeaderBytes: 64 * 1024,
        logger,
        calculateRequestPrice: (req: any) => {
            return topUpAmountFromRequest(req);
        }
    }))

    app.use('/api/v1', routes);

    app.use((error: any, req: any, res: any, _next: any) => {
        logger.error({
            requestId: req.requestId,
            method: req.method,
            path: req.path,
            error: error?.message || 'Unhandled request error',
            alert: 'cars.http.unhandled_error',
        }, 'Unhandled CARS request error');
        if (!res.headersSent) {
            res.status(500).json({
                error: 'Internal CARS error',
                code: 'CARS_INTERNAL_ERROR',
                requestId: req.requestId,
            });
        }
    });

    const server = app.listen(port, () => {
        logger.info(`CARS Node listening on port ${port}`);
    });
    disableRequestTimeout(server);
}

main().catch(err => {
    logger.fatal({ error: err?.message || String(err), alert: 'cars.startup.failed' }, 'CARS failed to start');
    process.exit(1);
});
