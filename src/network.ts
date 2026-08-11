export const PROJECT_NETWORKS = ['mainnet', 'testnet', 'teratestnet'] as const;

export type ProjectNetwork = typeof PROJECT_NETWORKS[number];
export type WalletChain = 'main' | 'test' | 'ttn';
export type OverlayNetwork = WalletChain;

export const DEFAULT_TTN_ARCADE_URL = 'https://arcade-v2-ttn-us-1.bsvblockchain.tech';
export const DEFAULT_TTN_STORAGE_URL = 'https://staging-storage.babbage.systems';
export const DEFAULT_TTN_CHAINTRACKS_API_PREFIX = '/chaintracks/v2';

export function normalizeProjectNetwork(value: unknown, defaultNetwork: ProjectNetwork = 'mainnet'): ProjectNetwork {
    if (value === undefined || value === null || value === '') return defaultNetwork;
    if (value === 'mainnet' || value === 'testnet' || value === 'teratestnet') return value;
    if (value === 'main') return 'mainnet';
    if (value === 'test') return 'testnet';
    if (value === 'ttn') return 'teratestnet';
    throw new TypeError(`Unsupported project network: ${String(value)}`);
}

export function projectNetworkToWalletChain(network: ProjectNetwork): WalletChain {
    if (network === 'mainnet') return 'main';
    if (network === 'testnet') return 'test';
    return 'ttn';
}

export const projectNetworkToOverlayNetwork = projectNetworkToWalletChain;

export function storageUrlForChain(chain: WalletChain, env: NodeJS.ProcessEnv = process.env): string {
    if (chain === 'main') return env.MAINNET_STORAGE_URL || 'https://storage.babbage.systems';
    if (chain === 'test') return env.TESTNET_STORAGE_URL || 'https://staging-storage.babbage.systems';
    return env.TTN_STORAGE_URL || DEFAULT_TTN_STORAGE_URL;
}

export function arcadeUrlForNetwork(network: ProjectNetwork, env: NodeJS.ProcessEnv = process.env): string | undefined {
    return network === 'teratestnet'
        ? env.TTN_ARCADE_URL || DEFAULT_TTN_ARCADE_URL
        : undefined;
}

export function chaintracksUrlForNetwork(network: ProjectNetwork, env: NodeJS.ProcessEnv = process.env): string | undefined {
    return network === 'teratestnet'
        ? env.TTN_CHAINTRACKS_URL || arcadeUrlForNetwork(network, env)
        : undefined;
}

export function chaintracksApiPrefixForNetwork(network: ProjectNetwork, env: NodeJS.ProcessEnv = process.env): string | undefined {
    return network === 'teratestnet'
        ? env.TTN_CHAINTRACKS_API_PREFIX || DEFAULT_TTN_CHAINTRACKS_API_PREFIX
        : undefined;
}

export function propagationEnvironmentForNetwork(
    network: ProjectNetwork,
    projectId: string,
    env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
    if (network === 'teratestnet') {
        return {
            ARCADE_URL: arcadeUrlForNetwork(network, env)!,
            ARCADE_API_KEY: env.TTN_ARCADE_API_KEY || '',
            ARCADE_DEPLOYMENT_ID: env.TTN_ARCADE_DEPLOYMENT_ID || projectId,
            CHAINTRACKS_URL: chaintracksUrlForNetwork(network, env)!,
            CHAINTRACKS_API_PREFIX: chaintracksApiPrefixForNetwork(network, env)!
        };
    }
    return {
        ARC_API_KEY: network === 'mainnet'
            ? env.TAAL_API_KEY_MAIN || ''
            : env.TAAL_API_KEY_TEST || ''
    };
}
