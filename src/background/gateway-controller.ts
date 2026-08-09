import {
  assertPairingCode,
  assertSteamId64,
  sha256Base64Url,
  utf8Bytes,
  type DevicePairPayload,
  type DeviceUnpairPayload,
} from '../shared/gateway-dto';
import type { IndexedDbDeviceKeyStore } from './device-key-store';
import type {
  InternalGatewayHandlers,
  InternalGatewayStatus,
} from './external-router';
import { GatewayClientError, ProtectedGatewayClient } from './gateway-client';
import {
  collectPortfolioSync,
  redactPortfolioFailure,
  type PortfolioCollectorSource,
  type PortfolioCollectorWarningCode,
  type SafePortfolioFailureCode,
} from './portfolio-collector';
import type { SteamReadSessionProvider } from './steam-read-session-provider';
import {
  clearGatewayOutbox,
  drainGatewayOutbox,
  enqueueGatewayEnvelope,
  getGatewayOutboxStatus,
} from './sync-outbox';

export interface GatewayControllerOptions {
  readonly client: ProtectedGatewayClient;
  readonly deviceKeys: IndexedDbDeviceKeyStore;
  readonly extensionVersion: string;
  readonly createSteamProvider: (
    steamId: string,
  ) => SteamReadSessionProvider | Promise<SteamReadSessionProvider>;
  /** Must reflect the user's explicit local opt-in at the moment sync starts. */
  readonly getEnabledSources: () => Promise<{
    readonly inventory: boolean;
    readonly tradeHistory: boolean;
    readonly tradeOffers: boolean;
  }>;
}

export class PortfolioSyncCancelledError extends Error {
  constructor() {
    super('portfolio-sync-cancelled-by-unpair');
    this.name = 'PortfolioSyncCancelledError';
  }
}

export class GatewayController implements InternalGatewayHandlers {
  private syncState: InternalGatewayStatus['syncState'] = 'idle';
  private lastFailureCode: SafePortfolioFailureCode | undefined;
  private syncEpoch = 0;
  private syncInFlight: Promise<{
    readonly queued: number;
    readonly inventoryItems: number;
    readonly trades: number;
    readonly offers: number;
    readonly failedSources: readonly PortfolioCollectorSource[];
    readonly warningCodes: readonly PortfolioCollectorWarningCode[];
  }> | null = null;
  private pairInFlight: Promise<{ readonly paired: true }> | null = null;
  private unpairInFlight: Promise<{ readonly unpaired: true }> | null = null;

  constructor(private readonly options: GatewayControllerOptions) {}

  pair(pairingCode: string): Promise<{ readonly paired: true }> {
    if (this.unpairInFlight) return Promise.reject(new Error('unpair-in-progress'));
    if (this.pairInFlight) return Promise.reject(new Error('pair-in-progress'));
    const pending = this.runPair(pairingCode);
    const tracked = pending.finally(() => {
      if (this.pairInFlight === tracked) this.pairInFlight = null;
    });
    this.pairInFlight = tracked;
    return tracked;
  }

  private async runPair(pairingCode: string): Promise<{ readonly paired: true }> {
    assertPairingCode(pairingCode);
    const existing = await this.options.deviceKeys.getRegistration();
    if (existing) throw new Error('already-paired');
    const identity = await this.options.deviceKeys.getOrCreateIdentity();
    const payload: DevicePairPayload = {
      kind: 'device.pair.v1',
      pairingCode,
      device: {
        deviceKeyId: identity.deviceKeyId,
        publicJwk: identity.publicJwk,
      },
      client: {
        extensionVersion: this.options.extensionVersion,
        platform: 'chromium-mv3',
        capabilities: [
          'inventory-context-2',
          'inventory-context-16',
          'recent-trades',
        ],
      },
    };
    try {
      const registration = await this.options.client.confirmPair(payload);
      await this.options.deviceKeys.saveRegistration({
        deviceId: registration.deviceId,
        steamId: registration.steamId,
        gatewayOrigin: registration.gatewayOrigin,
        recipientKeyId: registration.recipientKeyId,
        pairedAt: registration.pairedAt,
      });
      this.lastFailureCode = undefined;
      return { paired: true };
    } catch (error) {
      this.lastFailureCode = redactPortfolioFailure(error);
      throw error;
    }
  }

  unpair(): Promise<{ readonly unpaired: true }> {
    if (this.unpairInFlight) return this.unpairInFlight;
    const pending = this.runUnpair();
    this.unpairInFlight = pending.finally(() => {
      this.unpairInFlight = null;
    });
    return this.unpairInFlight;
  }

  private async runUnpair(): Promise<{ readonly unpaired: true }> {
    // Raise the fence synchronously, then wait for the stale run to observe it.
    // This orders every portfolio send/outbox write before the revoke request;
    // the final clear therefore cannot be undone by a late enqueue.
    this.syncEpoch += 1;
    // A pair request may already have reached the gateway but not yet saved its
    // local registration. Let it finish, then revoke that exact device instead
    // of taking the no-registration fast path and leaving an orphan pair.
    await this.pairInFlight?.catch(() => undefined);
    await this.syncInFlight?.catch(() => undefined);

    const registration = await this.options.deviceKeys.getRegistration();
    if (!registration) {
      await this.destroyLocalPairingState();
      return { unpaired: true };
    }
    let remoteConfirmed = false;
    try {
      const payload: DeviceUnpairPayload = { kind: 'device.unpair.v1', reason: 'user-request' };
      const envelope = await this.options.client.seal(payload, 'device.unpair', {
        deviceId: registration.deviceId,
      });
      const delivery = await this.options.client.sendEnvelope(envelope);
      if (!delivery.accepted && delivery.failureCode !== 'device-revoked') {
        this.lastFailureCode = delivery.retryable ? 'gateway-unavailable' : 'internal-error';
        throw new Error('unpair-not-confirmed');
      }
      remoteConfirmed = true;
    } finally {
      // Local consent revocation is authoritative even when the gateway is
      // offline. Destroying the registration/private key makes a remote orphan
      // unusable from this browser and survives an MV3 worker restart. The two
      // cleanup operations must be independent: a broken chrome.storage write
      // must never prevent IndexedDB key destruction.
      await this.destroyLocalPairingState();
    }
    if (remoteConfirmed) this.lastFailureCode = undefined;
    return { unpaired: true };
  }

  private async destroyLocalPairingState(): Promise<void> {
    const outcomes = await Promise.allSettled([
      clearGatewayOutbox(),
      this.options.deviceKeys.deleteIdentity(),
    ]);
    if (outcomes.some((outcome) => outcome.status === 'rejected')) {
      this.lastFailureCode = 'internal-error';
      throw new Error('local-unpair-cleanup-failed');
    }
  }

  async syncNow(): Promise<{
    readonly queued: number;
    readonly inventoryItems: number;
    readonly trades: number;
    readonly offers: number;
    readonly failedSources: readonly PortfolioCollectorSource[];
    readonly warningCodes: readonly PortfolioCollectorWarningCode[];
  }> {
    if (this.unpairInFlight) throw new PortfolioSyncCancelledError();
    if (this.syncInFlight) return this.syncInFlight;
    const epoch = this.syncEpoch;
    const pending = this.runSync(epoch);
    const tracked = pending.finally(() => {
      if (this.syncInFlight === tracked) this.syncInFlight = null;
    });
    this.syncInFlight = tracked;
    return tracked;
  }

  private assertSyncEpoch(epoch: number): void {
    if (epoch !== this.syncEpoch) throw new PortfolioSyncCancelledError();
  }

  private async runSync(epoch: number): Promise<{
    readonly queued: number;
    readonly inventoryItems: number;
    readonly trades: number;
    readonly offers: number;
    readonly failedSources: readonly PortfolioCollectorSource[];
    readonly warningCodes: readonly PortfolioCollectorWarningCode[];
  }> {
    let provider: SteamReadSessionProvider | null = null;
    try {
      const registration = await this.options.deviceKeys.getRegistration();
      this.assertSyncEpoch(epoch);
      if (!registration || registration.gatewayOrigin !== this.options.client.origin) {
        throw new Error('device-not-paired');
      }
      assertSteamId64(registration.steamId);
      this.syncState = 'syncing';
      provider = await this.options.createSteamProvider(registration.steamId);
      this.assertSyncEpoch(epoch);
      const sources = await this.options.getEnabledSources();
      this.assertSyncEpoch(epoch);
      const collected = await collectPortfolioSync({
        steamId: registration.steamId,
        provider,
        sources,
      });
      this.assertSyncEpoch(epoch);
      for (const chunk of collected.chunks) {
        const idempotencyKey = await sha256Base64Url(utf8Bytes(
          `portfolio.sync.v1:${registration.deviceId}:${chunk.syncRunId}:${chunk.chunkIndex}`,
        ));
        this.assertSyncEpoch(epoch);
        const envelope = await this.options.client.seal(chunk, 'portfolio.sync', {
          deviceId: registration.deviceId,
          idempotencyKey,
        });
        this.assertSyncEpoch(epoch);
        await enqueueGatewayEnvelope(envelope);
        this.assertSyncEpoch(epoch);
      }
      this.assertSyncEpoch(epoch);
      const delivery = await drainGatewayOutbox(
        async (envelope) => {
          this.assertSyncEpoch(epoch);
          return this.options.client.sendEnvelope(envelope);
        },
      );
      this.assertSyncEpoch(epoch);
      if (delivery.failed > 0) {
        throw new GatewayClientError(
          delivery.terminalFailureCodes.includes('device-revoked')
            ? 'DEVICE_REVOKED'
            : 'GATEWAY_REJECTED',
          false,
        );
      }
      // A run that queued everything and delivered nothing is not a sync. It
      // used to report "Synced · 274 records" while the server had rejected the
      // only envelope and the outbox still held it — the UI claimed a success
      // the backend never saw.
      if (delivery.delivered === 0 && delivery.deferred > 0) {
        throw new GatewayClientError('NETWORK_ERROR', true);
      }
      const outbox = await getGatewayOutboxStatus();
      this.assertSyncEpoch(epoch);
      this.syncState = 'idle';
      this.lastFailureCode = undefined;
      return {
        queued: outbox.pending,
        inventoryItems: collected.summary.context2Items + collected.summary.context16Items,
        trades: collected.summary.trades,
        offers: collected.summary.offers,
        failedSources: collected.summary.failedSources,
        warningCodes: collected.summary.warningCodes,
      };
    } catch (error) {
      if (error instanceof PortfolioSyncCancelledError) {
        this.syncState = 'idle';
        throw error;
      }
      this.syncState = 'error';
      this.lastFailureCode = redactPortfolioFailure(error);
      throw error;
    } finally {
      provider?.forgetSession();
    }
  }

  async status(): Promise<InternalGatewayStatus> {
    const [registration, outbox] = await Promise.all([
      this.options.deviceKeys.getRegistration(),
      getGatewayOutboxStatus(),
    ]);
    return {
      paired: registration !== null,
      syncState: this.syncState,
      pendingEncryptedRequests: outbox.pending,
      ...(this.lastFailureCode ? { lastFailureCode: this.lastFailureCode } : {}),
    };
  }
}
