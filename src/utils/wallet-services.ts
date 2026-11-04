import { GoChaintracksServiceClient, Services } from '@bsv/wallet-toolbox-client';
import { WalletChain, arcadeUrlForNetwork } from '../network';

/** Keep wallet proof verification on an explicitly qualified mainnet provider. */
export function walletServiceOptions(chain: WalletChain, env: NodeJS.ProcessEnv = process.env) {
    const options = Services.createDefaultOptions(chain);
    const endpoint = env.CARS_MAINNET_CHAINTRACKS_URL?.trim();
    if (chain === 'main' && endpoint) {
        const url = new URL(endpoint);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/v2')) {
            throw new Error('CARS_MAINNET_CHAINTRACKS_URL must be a credential-free HTTPS v2 endpoint');
        }
        options.chaintracks = new GoChaintracksServiceClient(chain, url.href);
    }
    if (chain === 'ttn') {
        options.arcadeUrl = arcadeUrlForNetwork('teratestnet', env);
        options.arcadeConfig = {
            ...options.arcadeConfig,
            apiKey: env.TTN_ARCADE_API_KEY || options.arcadeConfig?.apiKey,
            deploymentId: env.TTN_ARCADE_DEPLOYMENT_ID || options.arcadeConfig?.deploymentId
        };
    }
    return options;
}
