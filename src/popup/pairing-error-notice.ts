const GENERIC_PAIRING_FAILURE =
  'Pairing failed. Generate a fresh code in CSFolder and try again.';

const BUILD_CONFIGURATION_ERRORS = new Set([
  'GATEWAY_BUILD_CONFIG_UNAVAILABLE',
  'GATEWAY_BUILD_CONFIG_INVALID',
  'GATEWAY_ORIGIN_NOT_PINNED',
  'UNCONFIGURED',
]);

/** Maps internal failures to bounded, non-secret guidance for the popup. */
export function pairingFailureNotice(error: unknown): string {
  const code = error instanceof Error ? error.message : '';

  if (BUILD_CONFIGURATION_ERRORS.has(code)) {
    return 'This extension is not connected to the CSBOARD pairing gateway. Reload the production-configured build.';
  }
  if (code === 'DISCOVERY_REJECTED') {
    return 'The CSBOARD gateway security key does not match this extension build. Reload the matching build.';
  }
  if (code === 'GATEWAY_REJECTED') {
    return 'CSBOARD rejected this pairing request. Generate a fresh code in CSFolder and try again.';
  }
  if (code === 'NETWORK_ERROR') {
    return 'Could not reach CSBOARD. Check your connection and try pairing again.';
  }

  return GENERIC_PAIRING_FAILURE;
}
