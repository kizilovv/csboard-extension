import type { PinnedGatewayRoot } from './gateway-client';

type BuildRootJwk = JsonWebKey & { readonly kid?: string };

function validateBuildOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value ||
      (value !== 'https://csboard.com' && value !== 'https://csboard.trade')) {
    throw new Error('GATEWAY_BUILD_CONFIG_INVALID');
  }
  return value;
}

export function readGatewayBuildConfig(): {
  readonly allowedOrigins: readonly string[];
  readonly pinnedRoot: PinnedGatewayRoot;
} {
  const allowedOrigins = __CSBOARD_GATEWAY_HOSTS__.map(validateBuildOrigin);
  if (allowedOrigins.length !== 2 || new Set(allowedOrigins).size !== 2) {
    throw new Error('GATEWAY_BUILD_CONFIG_INVALID');
  }
  const root = __CSBOARD_GATEWAY_ROOT_JWK__ as Readonly<BuildRootJwk> | null;
  if (!root || root.kty !== 'EC' || root.crv !== 'P-256' ||
      typeof root.x !== 'string' || typeof root.y !== 'string' ||
      typeof root.kid !== 'string' || !/^[A-Za-z0-9._-]{3,128}$/.test(root.kid) ||
      root.d !== undefined) {
    throw new Error('GATEWAY_BUILD_CONFIG_UNAVAILABLE');
  }
  return {
    allowedOrigins,
    pinnedRoot: { keyId: root.kid, publicJwk: root },
  };
}
