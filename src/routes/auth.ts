import { Router, Request, Response } from 'express';
import logger from '../logger';
import type { Knex } from 'knex';
const router = Router();
const EMAIL_CERTIFIER = '02cf6cdf466951d8dfc9e7c9367511d0007ed6fba35ed42d425cc412fd6cfd4a17';
const EMAIL_CERTIFICATE_TYPE = 'exOl3KM0dIJ04EW5pZgbZmPag6MdJXd3/a1enmUU/BA=';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/register', async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const identityKey = (req as any).auth.identityKey;
    try {
        const certs = (req as any).auth.certificates || [];
        const emailCertificate = certs.find((certificate: any) =>
            certificate?.certifier === EMAIL_CERTIFIER &&
            certificate?.type === EMAIL_CERTIFICATE_TYPE &&
            typeof certificate?.decryptedFields?.email === 'string'
        );
        const candidateEmail = String(emailCertificate?.decryptedFields?.email || '').trim().toLowerCase();
        const email = candidateEmail.length <= 254 && EMAIL_PATTERN.test(candidateEmail)
            ? candidateEmail
            : 'placeholder@domain.com';

        // Insert user if not exists
        const existing = await db('users').where({ identity_key: identityKey }).first();
        if (!existing) {
            await db('users').insert({ identity_key: identityKey, email });
            logger.info({ identityKey, hasVerifiedEmail: email !== 'placeholder@domain.com' }, 'User registered');
        } else {
            logger.info({ identityKey }, 'User already registered');
        }

        const userCount = await db('users').count('* as cnt').first();
        res.json({
            message: 'User registered',
            userCount: userCount.cnt,
            data: {
                userCount: userCount.cnt
            }
        });
    } catch (e) {
        res.status(400).json({ message: 'Invalid or missing email certificate' })
    }
});

export default router;
