import { WalletInterface, PrivateKey, P2PKH, PublicKey, InternalizeActionArgs, CachedKeyDeriver } from '@bsv/sdk';
import type { Knex } from 'knex';
import logger from '../logger';
import crypto from 'crypto';
import { Services, StorageClient, Wallet, WalletSigner, WalletStorageManager } from '@bsv/wallet-toolbox-client';
import {
    ProjectNetwork,
    WalletChain,
    arcadeUrlForNetwork,
    projectNetworkToWalletChain,
    storageUrlForChain
} from '../network';

export type ProjectWallets = Partial<Record<ProjectNetwork, WalletInterface>>;

export async function makeWallet(chain: WalletChain, privateKey: string): Promise<WalletInterface> {
    const keyDeriver = new CachedKeyDeriver(new PrivateKey(privateKey, 'hex'));
    const storageManager = new WalletStorageManager(keyDeriver.identityKey);
    const signer = new WalletSigner(chain, keyDeriver, storageManager);
    const serviceOptions = Services.createDefaultOptions(chain);
    if (chain === 'ttn') {
        serviceOptions.arcadeUrl = arcadeUrlForNetwork('teratestnet');
        serviceOptions.arcadeConfig = {
            ...serviceOptions.arcadeConfig,
            apiKey: process.env.TTN_ARCADE_API_KEY || serviceOptions.arcadeConfig?.apiKey,
            deploymentId: process.env.TTN_ARCADE_DEPLOYMENT_ID || serviceOptions.arcadeConfig?.deploymentId
        };
    }
    const services = new Services(serviceOptions);
    const wallet = new Wallet(signer, services);
    const client = new StorageClient(
        wallet,
        storageUrlForChain(chain)
    );
    await client.makeAvailable();
    await storageManager.addWalletStorageProvider(client);
    return wallet;
}

export async function findBalanceForKey(privateKey: string, network: ProjectNetwork = 'mainnet'): Promise<number> {
    const wallet = await makeWallet(projectNetworkToWalletChain(network), privateKey);
    const { outputs: outputsInDefaultBasket } = await wallet.listOutputs({ basket: 'default', limit: 10000 });
    const balance = outputsInDefaultBasket.reduce((a, e) => a + e.satoshis, 0);
    return balance;
}

export async function fundKey(
    fromWallet: WalletInterface,
    toPrivateKey: string,
    amount: number,
    network: ProjectNetwork = 'mainnet'
): Promise<boolean> {
    const { outputs: outputsInDefaultBasket } = await fromWallet.listOutputs({ basket: 'default', limit: 10000 });
    const serverBalance = outputsInDefaultBasket.reduce((a, e) => a + e.satoshis, 0);
    if (serverBalance < amount) {
        throw new Error('Server balance is insufficient for funding');
    }
    const toWallet = await makeWallet(projectNetworkToWalletChain(network), toPrivateKey);
    const derivationPrefix = crypto.randomBytes(10).toString('base64');
    const derivationSuffix = crypto.randomBytes(10).toString('base64');
    const { publicKey: payer } = await fromWallet.getPublicKey({ identityKey: true })
    const payee = new PrivateKey(toPrivateKey, 16).toPublicKey().toString()
    const { publicKey: derivedPublicKey } = await fromWallet.getPublicKey({
        counterparty: payee,
        protocolID: [2, '3241645161d8'],
        keyID: `${derivationPrefix} ${derivationSuffix}`
    });
    const lockingScript = new P2PKH().lock(PublicKey.fromString(derivedPublicKey).toAddress()).toHex();
    const outputs = [{
        lockingScript,
        satoshis: amount,
        outputDescription: 'Fund a CARS key',
        customInstructions: JSON.stringify({ derivationPrefix, derivationSuffix, payee })
    }];
    const transaction = await fromWallet.createAction({
        outputs,
        description: 'Funding CARS host for SHIP/SLAP',
        options: {
            randomizeOutputs: false
        }
    });
    const directTransaction: InternalizeActionArgs = {
        tx: transaction.tx!,
        outputs: [{
            outputIndex: 0,
            protocol: 'wallet payment',
            paymentRemittance: {
                derivationPrefix,
                derivationSuffix,
                senderIdentityKey: payer
            }
        }],
        description: 'Payment from CARS hosting provider for SHIP/SLAP'
    };
    await toWallet.internalizeAction(directTransaction);
    return true;
}

export function walletForProjectNetwork(wallets: ProjectWallets, network: ProjectNetwork): WalletInterface {
    const wallet = wallets[network];
    if (!wallet) {
        throw new Error(`${network} wallet is not configured on this CARS node`);
    }
    return wallet;
}

export async function checkAndFundProjectKeys(db: Knex, wallets: ProjectWallets) {
    const projects = await db('projects')
        .select('projects.*')
        .where('balance', '>', 0);

    for (const project of projects) {
        try {
            const key = project.private_key;
            if (typeof key !== 'string' || key.length !== 64) continue;
            const network = project.network as ProjectNetwork;
            const balance = await findBalanceForKey(key, network);

            if (balance < 100) {
                const neededAmount = 500 - balance;
                const fundingAmount = Math.min(neededAmount, project.balance);
                if (fundingAmount <= 100) continue;
                const sourceWallet = walletForProjectNetwork(wallets, network);

                const funded = await fundKey(
                    sourceWallet,
                    project.private_key,
                    fundingAmount,
                    network
                );

                if (funded) {
                    if (network === 'mainnet') {
                        await db('projects')
                            .where({ id: project.id })
                            .decrement('balance', fundingAmount);
                    } else {
                        await db('projects')
                            .where({ id: project.id })
                            .decrement('balance', Math.round(fundingAmount / 10));
                    }

                    logger.info({
                        projectId: project.project_uuid,
                        network: project.network,
                        amount: fundingAmount
                    }, 'Project key funded');
                }
            }
        } catch (error: any) {
            logger.error({
                projectId: project.project_uuid,
                network: project.network,
                error: error?.message || 'Unknown project funding error',
                alert: 'cars.cron.project_key.failed',
            }, 'Failed to inspect or fund project key');
        }
    }
}
