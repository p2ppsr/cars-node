import { Transaction, PushDrop, Utils, ProtoWallet } from '@bsv/sdk';
import crypto from 'node:crypto';
import logger from '../logger';
import axios from 'axios';
import { getInternalBackendUrl } from './projects';

interface Takedown {
  outpoint: string;
  authority: string;
  authorityRequiredSignatures: number;
  humanReadableMessage: string;
  takedownNumber: string;
  signatures: Array<{ officerIdentityKey: string; officerSignature: string }>;
}

interface RecognizedAuthority {
  name: string;
  authorityRequiredSignatures: number;
  officerIdentityKeys: string[];
}

function parseAuthorities(raw = process.env.RECOGNIZED_TAKEDOWN_AUTHORITIES || '[]'): RecognizedAuthority[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length > 100) throw new Error('Invalid recognized takedown authority configuration');
  return parsed.map(authority => {
    if (
      !authority || typeof authority.name !== 'string' || authority.name.length < 1 || authority.name.length > 128 ||
      !Number.isSafeInteger(authority.authorityRequiredSignatures) || authority.authorityRequiredSignatures < 1 ||
      !Array.isArray(authority.officerIdentityKeys) || authority.officerIdentityKeys.length > 100
    ) throw new Error('Invalid recognized takedown authority configuration');
    const officerIdentityKeys = [...new Set<string>(authority.officerIdentityKeys)];
    if (
      officerIdentityKeys.length !== authority.officerIdentityKeys.length ||
      officerIdentityKeys.some(key => typeof key !== 'string' || !/^[a-f0-9]{66}$/i.test(key)) ||
      authority.authorityRequiredSignatures > officerIdentityKeys.length
    ) throw new Error('Invalid recognized takedown authority configuration');
    return { ...authority, officerIdentityKeys };
  });
}

function validateTakedown(takedown: any): asserts takedown is Takedown {
  if (
    !takedown || typeof takedown.authority !== 'string' || takedown.authority.length > 128 ||
    typeof takedown.outpoint !== 'string' || !/^[a-f0-9]{64}\.[0-9]{1,10}$/i.test(takedown.outpoint) ||
    typeof takedown.takedownNumber !== 'string' || takedown.takedownNumber.length < 1 || takedown.takedownNumber.length > 128 ||
    typeof takedown.humanReadableMessage !== 'string' || takedown.humanReadableMessage.length > 10_000 ||
    !Number.isSafeInteger(takedown.authorityRequiredSignatures) || takedown.authorityRequiredSignatures < 1 ||
    !Array.isArray(takedown.signatures) || takedown.signatures.length > 100
  ) throw new Error('Malformed takedown notice');
}

async function authorizeTakedown(
  takedown: Takedown,
  authorities: RecognizedAuthority[],
  verify: (identityKey: string, signature: string, data: number[], keyID: string) => Promise<boolean>,
): Promise<boolean> {
  const authority = authorities.find(candidate => candidate.name === takedown.authority);
  if (
    !authority || authority.authorityRequiredSignatures !== takedown.authorityRequiredSignatures ||
    takedown.signatures.length < authority.authorityRequiredSignatures
  ) return false;
  const message = Utils.toArray(
    `${takedown.authority}\n${takedown.outpoint}\n${takedown.takedownNumber}\n${takedown.humanReadableMessage}`,
    'utf8',
  );
  const allowed = new Set(authority.officerIdentityKeys.map(key => key.toLowerCase()));
  const validOfficers = new Set<string>();
  for (const candidate of takedown.signatures) {
    if (
      !candidate || typeof candidate.officerIdentityKey !== 'string' ||
      typeof candidate.officerSignature !== 'string' || !/^[a-f0-9]{64,512}$/i.test(candidate.officerSignature)
    ) continue;
    const officer = candidate.officerIdentityKey.toLowerCase();
    if (!allowed.has(officer) || validOfficers.has(officer)) continue;
    try {
      if (await verify(candidate.officerIdentityKey, candidate.officerSignature, message, takedown.takedownNumber)) {
        validOfficers.add(officer);
      }
    } catch {
      // Invalid signatures do not count toward the configured threshold.
    }
  }
  return validOfficers.size >= authority.authorityRequiredSignatures;
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, handler: (item: T) => Promise<void>) {
  let cursor = 0;
  const failures: Error[] = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        await handler(items[index]);
      } catch (error) {
        failures.push(error as Error);
      }
    }
  }));
  return failures;
}

function takedownOperationId(takedown: Takedown): string {
  return crypto.createHash('sha256').update([
    takedown.authority,
    takedown.outpoint,
    takedown.takedownNumber,
    takedown.humanReadableMessage,
  ].join('\0')).digest('hex');
}

async function claimTakedown(db: any, operationId: string): Promise<'claimed' | 'active' | 'succeeded'> {
  try {
    await db('cars_takedown_operations').insert({ operation_id: operationId });
    return 'claimed';
  } catch (error: any) {
    if (error?.code !== 'ER_DUP_ENTRY' && error?.errno !== 1062) throw error;
  }
  return await db.transaction(async trx => {
    const operation = await trx('cars_takedown_operations').where({ operation_id: operationId }).forUpdate().first();
    if (!operation) throw new Error('Takedown replay record disappeared');
    if (operation.status === 'succeeded') return 'succeeded';
    const ageMs = Date.now() - new Date(operation.updated_at).getTime();
    if (operation.status === 'pending' && Number.isFinite(ageMs) && ageMs < 5 * 60 * 1000) return 'active';
    await trx('cars_takedown_operations').where({ operation_id: operationId }).update({
      status: 'pending',
      attempts: Number(operation.attempts || 0) + 1,
      error: null,
      updated_at: trx.fn.now(),
    });
    return 'claimed';
  });
}

/** Public cryptographic takedown endpoint; the authority threshold is its authorization. */
export default async (req, res) => {
  let operationId: string | undefined;
  try {
    if (!Buffer.isBuffer(req.body)) {
      return res.status(415).json({ error: 'Takedown notices must use application/octet-stream' });
    }
    const body: Buffer = req.body;
    if (body.length < 1 || body.length > 2 * 1024 * 1024) {
      return res.status(413).json({ error: 'Takedown notice is too large' });
    }
    const tx = Transaction.fromBEEF(Array.from(body));
    await tx.verify();
    if (!tx.outputs[0]) return res.status(400).json({ error: 'Not actioned.' });
    const { fields: [json] } = PushDrop.decode(tx.outputs[0].lockingScript);
    const takedown: unknown = JSON.parse(Utils.toUTF8(json));
    validateTakedown(takedown);

    const anyoneWallet = new ProtoWallet('anyone');
    const authorized = await authorizeTakedown(
      takedown,
      parseAuthorities(),
      async (identityKey, signature, data, keyID) => {
        const result = await anyoneWallet.verifySignature({
          protocolID: [2, 'takedown'], keyID, data, counterparty: identityKey,
          signature: Utils.toArray(signature, 'hex'),
        });
        return result.valid;
      },
    );
    if (!authorized) return res.status(400).json({ error: 'Not actioned.' });

    const [txid, outputIndexString] = takedown.outpoint.split('.');
    const outputIndex = Number(outputIndexString);
    if (!Number.isSafeInteger(outputIndex) || outputIndex < 0 || outputIndex > 0xffffffff) {
      return res.status(400).json({ error: 'Not actioned.' });
    }
    operationId = takedownOperationId(takedown);
    const claim = await claimTakedown(req.db, operationId);
    if (claim === 'succeeded') return res.status(200).json({ message: 'Already actioned.' });
    if (claim === 'active') return res.status(409).json({ error: 'This takedown is already being actioned' });
    const projects: any[] = await req.db('projects')
      .join('cars_advertised_capabilities', 'cars_advertised_capabilities.project_id', 'projects.id')
      .where({ 'cars_advertised_capabilities.active': true })
      .whereNotNull('projects.admin_bearer_token')
      .distinct('projects.project_uuid', 'projects.admin_bearer_token');
    const failures = await mapWithConcurrency(projects, 5, async project => {
      await axios.post(`${getInternalBackendUrl(project)}/admin/evictOutpoint`, { txid, outputIndex }, {
        headers: { Authorization: `Bearer ${project.admin_bearer_token}` },
        timeout: 120_000,
        maxRedirects: 0,
        maxContentLength: 1024 * 1024,
        maxBodyLength: 1024 * 1024,
      });
    });
    if (failures.length) {
      await req.db('cars_takedown_operations').where({ operation_id: operationId }).update({
        status: 'failed',
        error: `${failures.length} project actions failed`.slice(0, 2000),
        updated_at: req.db.fn.now(),
      });
      logger.error({
        takedownNumber: takedown.takedownNumber,
        projectCount: projects.length,
        failedProjects: failures.length,
        errors: failures.slice(0, 10).map(error => error.message),
        alert: 'cars.global_eviction.partial_failure',
      }, 'Authorized global eviction was not applied to every project');
      return res.status(503).json({ error: 'Takedown was authorized but requires retry', code: 'CARS_EVICTION_PARTIAL_FAILURE' });
    }
    await req.db('cars_takedown_operations').where({ operation_id: operationId }).update({
      status: 'succeeded',
      error: null,
      updated_at: req.db.fn.now(),
    });
    logger.info({ takedownNumber: takedown.takedownNumber, projectCount: projects.length }, 'Authorized global eviction completed');
    res.status(200).json({ message: 'Actioned.' });
  } catch (error: any) {
    if (operationId) {
      await req.db('cars_takedown_operations').where({ operation_id: operationId }).update({
        status: 'failed',
        error: String(error?.message || 'Unknown takedown failure').slice(0, 2000),
        updated_at: req.db.fn.now(),
      }).catch(() => undefined);
    }
    logger.warn({ error: error.message, alert: 'cars.global_eviction.rejected' }, 'Takedown request rejected');
    res.status(400).json({ error: 'Error with takedown request, not actioned.' });
  }
};

export { authorizeTakedown, parseAuthorities, validateTakedown, takedownOperationId, claimTakedown };
