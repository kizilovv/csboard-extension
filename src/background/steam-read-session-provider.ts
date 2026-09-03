import {
  GatewayPayloadError,
  MAX_PORTFOLIO_OFFERS_PER_RUN,
  assertSteamId64,
  type PortfolioItemDto,
  type PortfolioMarketplaceHint,
  type PortfolioOfferDto,
  type PortfolioTradeDto,
  type PortfolioTradeItemDto,
  type SteamInventoryContextId,
} from '../shared/gateway-dto';
import { parseSteamAssetProperties } from '../shared/steam-asset-properties';

const STEAM_API_ROOT = 'https://api.steampowered.com/IEconService';
const STEAM_TOKEN_PAGE = 'https://steamcommunity.com/my/tradehistory?l=english';
const MAX_INVENTORY_PAGES = 20;
// Portfolio auto-sync runs hourly. A five-minute local TTL made the worker
// throw away a still-valid first-party page token long before the next run and
// fall back to a cross-site Steam page fetch that third-party-cookie blocking
// commonly answers as logged out. The token remains process-memory-only and is
// still rejected immediately by Steam when it actually expires.
const TOKEN_MEMORY_TTL_MS = 70 * 60 * 1_000;
/** How far back settled offers stay interesting to a portfolio. */
const OFFER_HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;


export interface SteamInventoryReadResult {
  readonly contextId: SteamInventoryContextId;
  readonly complete: true;
  readonly items: readonly PortfolioItemDto[];
}

export interface SteamTradesReadResult {
  readonly complete: true;
  readonly trades: readonly PortfolioTradeDto[];
  readonly hasMore?: boolean;
  readonly totalTrades?: number;
  /**
   * Icon per `classId:instanceId`, kept OUTSIDE the trade DTO on purpose: that
   * DTO is what the gateway uploads and the server validates strictly, so an
   * extra field there turns into a rejected sync. Local views need the picture,
   * the gateway does not.
   */
  readonly icons: Readonly<Record<string, string>>;
  /** Steam rarity colour per `classId:instanceId`, same reasoning as icons. */
  readonly nameColors: Readonly<Record<string, string>>;
  /*
    Steam's `ETradeStatus` per tradeId, kept OUTSIDE the DTO for the same reason
    as the icons above: the gateway validates that shape strictly and an extra
    field turns into a rejected sync.

    It is here because a completed trade and a ROLLED-BACK trade are the same
    row with a different status. After the buyer accepts, the skin sits in
    Steam's 7-day hold and the seller can still reverse it — and nothing outside
    the seller's own session can see that happen. Reading the trade but dropping
    its status would mean watching the one event we most need to catch and
    recording it as success.
  */
  readonly statuses: Readonly<Record<string, number>>;
}

export interface SteamTradeHistoryCursor {
  readonly startAfterTime: number;
  readonly startAfterTradeId: string;
}

export interface SteamTradesReadOptions {
  readonly cursor?: SteamTradeHistoryCursor;
  readonly includeTotal?: boolean;
  /*
    Ask Steam for the description table, or do without it.

    ON by default, because portfolio sync is what this reader was written for
    and a trade with no item names is not a portfolio record.

    OFF is for the P2P tracker, which matches an order to a trade by ASSET ID
    and never looks at a name. The table is most of the response — one page of
    250 trades is a few hundred KB of icon hashes, localized tag names and
    sticker HTML to answer "did asset 52186124273 move" — and every byte of it
    crosses the extension's message boundary. `normalizeTradeItem` already
    treats a missing description as "no name, no icon" rather than an error, so
    dropping it costs the tracker nothing at all.
  */
  readonly getDescriptions?: boolean;
  /*
    Skip a row this parser cannot read instead of failing the whole page.

    Off by default, because portfolio sync is a record of item movement and a
    half-parsed sync is worse than no sync. The P2P tracker wants the opposite:
    it is looking for ONE trade among a hundred, and one malformed neighbour
    taking the read down means a Steam rollback goes unseen — and a rollback
    moves the items back and never the money.
  */
  readonly skipUnreadableRows?: boolean;
}

export interface SteamOffersReadResult {
  readonly complete: true;
  readonly offers: readonly PortfolioOfferDto[];
  /** Safe status only; no discarded offer fields cross this boundary. */
  readonly warningCode?: typeof STEAM_OFFERS_TRUNCATED_WARNING;
}

/**
 * What the trade-offers PAGE needs, which is a different set from what the
 * gateway uploads. `PortfolioTradeItemDto` keeps ids, market name, and the
 * trusted icon needed for exact Doppler phase identity; the page additionally
 * reads `descriptions` for sticker/charm rows and `tags` for rarity/exterior
 * colouring. Feeding the page the portfolio DTO silently zeroed those richer
 * presentation fields.
 *
 * These fields are Steam's own description payload, passed through unchanged —
 * the same trust level the inventory page already reads straight out of the
 * Steam page context.
 */
export interface SteamOfferDisplayItem {
  readonly appid: string;
  readonly contextid: string;
  readonly assetid: string;
  readonly classid: string;
  readonly instanceid: string;
  readonly amount: string;
  /** Index within its side of the offer — the page matches DOM tiles by it. */
  readonly position: number;
  readonly name?: string;
  readonly market_hash_name?: string;
  readonly name_color?: string;
  readonly type?: string;
  readonly icon_url?: string;
  readonly tradable?: unknown;
  readonly marketable?: unknown;
  readonly tags?: unknown;
  readonly descriptions?: unknown;
  readonly owner_descriptions?: unknown;
}

export interface SteamOfferDisplayOffer {
  readonly tradeofferid: string;
  readonly accountid_other: string;
  readonly trade_offer_state: number;
  readonly time_created: number;
  readonly expiration_time?: number;
  readonly escrow_end_date?: number;
  readonly direction: 'sent' | 'received';
  readonly items_to_give: readonly SteamOfferDisplayItem[];
  readonly items_to_receive: readonly SteamOfferDisplayItem[];
}

export interface SteamOffersDisplayReadOptions {
  readonly activeOnly?: boolean;
  readonly sent?: boolean;
  readonly received?: boolean;
}

export interface SteamOffersDisplayReadResult {
  readonly complete: true;
  readonly offers: readonly SteamOfferDisplayOffer[];
}

export const STEAM_OFFERS_TRUNCATED_WARNING = 'TRADE_OFFERS_TRUNCATED' as const;

/** Fixed read-only surface. There is intentionally no generic fetch/token method. */
export interface SteamReadSessionProvider {
  readInventoryContext(contextId: SteamInventoryContextId): Promise<SteamInventoryReadResult>;
  readRecentTrades(
    maxTrades?: number,
    options?: SteamTradesReadOptions,
  ): Promise<SteamTradesReadResult>;
  readTradeOffers(): Promise<SteamOffersReadResult>;
  readTradeOffersForDisplay(
    options?: SteamOffersDisplayReadOptions,
  ): Promise<SteamOffersDisplayReadResult>;
  /**
   * Hands the provider a webapi token that a content script already had in the
   * page DOM (`#application_config[data-loyalty_webapi_token]`).
   *
   * 🔴 Why this exists: the provider's own mint fetches steamcommunity.com from
   * the service worker, and that request is cross-site relative to the
   * `chrome-extension://` origin. With third-party cookies blocked — now the
   * common default — Steam answers it logged-out, the mint fails, and every
   * read on the page dies with STEAM_SESSION_REQUIRED even though the user is
   * plainly signed in. The page always has the token first-party; the service
   * worker only sometimes can get one.
   *
   * The token still never leaves the provider: nothing returns it, and it is
   * accepted only for the Steam account the provider was created for.
   */
  offerAccessToken(token: string, tokenSteamId: string): void;
  /** Safe boolean only; the token itself never crosses this boundary. */
  hasUsableAccessToken?(): boolean;
  /** Re-mints in place; callers receive only completion, never the credential. */
  refreshAccessToken?(): Promise<void>;
  forgetSession(): void;
}

export interface SteamReadSessionProviderOptions {
  readonly steamId: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  /** Private worker/tab bridge; its return value must never be persisted/logged. */
  readonly requestFirstPartyCredential?: () => Promise<{
    readonly token: string;
    readonly steamId: string;
  } | null>;
}

interface MemoryToken {
  readonly value: string;
  readonly mintedAt: number;
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path });
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function optionalString(value: unknown, maxLength = 512): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const normalized = String(value).trim();
  if (!normalized || normalized.length > maxLength) return undefined;
  return normalized;
}

function requiredDigits(value: unknown, path: string, maxLength = 32): string {
  const normalized = optionalString(value, maxLength);
  if (!normalized || !new RegExp(`^[0-9]{1,${maxLength}}$`).test(normalized)) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path });
  }
  return normalized;
}

function optionalInteger(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : undefined;
}

function optionalPortfolioTimestamp(value: unknown): number | undefined {
  const timestamp = optionalInteger(value);
  return timestamp !== undefined && timestamp >= 1 && timestamp <= 9_999_999_999
    ? timestamp
    : undefined;
}

function buildAssetPropertiesMap(value: unknown): Map<string, Record<string, unknown>> {
  const properties = new Map<string, Record<string, unknown>>();
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const property = asRecord(entry, `$.asset_properties[${index}]`);
      const assetId = optionalString(property['assetid'], 32);
      if (assetId && /^[0-9]+$/.test(assetId)) properties.set(assetId, property);
    }
    return properties;
  }
  if (value === undefined || value === null) return properties;

  const propertyMap = asRecord(value, '$.asset_properties');
  for (const [assetId, entry] of Object.entries(propertyMap)) {
    if (!/^[0-9]{1,32}$/.test(assetId)) continue;
    properties.set(
      assetId,
      Array.isArray(entry)
        ? { asset_properties: entry }
        : asRecord(entry, `$.asset_properties.${assetId}`),
    );
  }
  return properties;
}

/**
 * Reduce a private Steam offer note to one allowlisted venue signal. The note
 * itself never enters the portfolio DTO, logs, storage, or the gateway.
 */
function marketplaceHintFromOfferMessage(value: unknown): PortfolioMarketplaceHint | undefined {
  const message = optionalString(value, 1_024)?.toLowerCase();
  if (!message) return undefined;
  const compactMessage = message.trim().replace(/\s+/g, ' ');
  const hints = new Set<PortfolioMarketplaceHint>();
  const mentionsExplicitBuff = /\b(?:buff163|buff\.163(?:\.com)?|buff\.market)\b/.test(message);
  const mentionsBareBuff = /\bbuff\b/.test(message);
  const mentionsBareBuffVenue = compactMessage === 'buff' ||
    /\b(?:from|via|on)\s+buff\b/.test(message) ||
    /\bbuff\s+(?:order|purchase|delivery)\b/.test(message);
  const mentionsCsfloat = /\b(?:csfloat|csgofloat)(?:\.com)?\b/.test(message);
  if ((mentionsExplicitBuff || mentionsBareBuff) && mentionsCsfloat) return undefined;
  // Steam marketplace notes commonly contain the venue name or domain. Keep
  // bare `buff` conservative so normal prose cannot trigger purchase booking.
  if (mentionsExplicitBuff || mentionsBareBuffVenue) {
    hints.add('buff163');
  }
  if (mentionsCsfloat) hints.add('csfloat');
  return hints.size === 1 ? [...hints][0] : undefined;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareDigitStringsDescending(left: string, right: string): number {
  if (left.length !== right.length) return right.length - left.length;
  return -compareAscii(left, right);
}

function newestOfferFirst(left: PortfolioOfferDto, right: PortfolioOfferDto): number {
  return right.createdAt - left.createdAt ||
    compareDigitStringsDescending(left.offerId, right.offerId) ||
    compareAscii(left.direction, right.direction);
}

function readResponseRoot(value: unknown): Record<string, unknown> {
  const root = asRecord(value, '$');
  return asRecord(root['response'], '$.response');
}

function buildDescriptionMap(descriptions: readonly unknown[]): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const entry of descriptions) {
    const description = asRecord(entry, '$.descriptions[]');
    const classId = optionalString(description['classid'], 32);
    const instanceId = optionalString(description['instanceid'], 32) ?? '0';
    if (classId && /^[0-9]+$/.test(classId) && /^[0-9]+$/.test(instanceId)) {
      map.set(`${classId}:${instanceId}`, description);
    }
  }
  return map;
}

/**
 * Recovers the trade-hold end from the owner-only description.
 *
 * Steam leaves `tradable_after` empty on this inventory read (verified against
 * a live account: 57 held context-16 assets, zero with the field, and no
 * `cache_expiration` either). The instant it does ship is a BBCode token inside
 * `owner_descriptions`:
 *
 *   "This item is trade-protected and cannot be consumed, modified, or
 *    transferred until [date]1786384800[/date]"
 *
 * The payload carries the raw Unix seconds — the human date the Steam client
 * shows is rendered from it locally — so this parse is independent of the
 * account's language and cannot break when Steam translates the sentence.
 *
 * Only `owner_descriptions` carries it, and Steam serves those exclusively to
 * the signed-in owner. That is why no server-side reader can recover a hold end
 * date: it is not in any response a third party can obtain.
 *
 * Matching is on the token, not the prose. Steam emits at most one dated
 * owner-description per item; the latest wins so a future second line can never
 * shorten a hold.
 */
function tradableAfterFromOwnerDescriptions(
  description: Record<string, unknown>,
): number | undefined {
  let latest: number | undefined;
  for (const entry of asArray(description['owner_descriptions'])) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const value = optionalString((entry as Record<string, unknown>)['value'], 1_024);
    if (!value) continue;
    for (const match of value.matchAll(/\[date\](\d{1,10})\[\/date\]/g)) {
      const seconds = optionalInteger(match[1]);
      if (seconds === undefined || seconds === 0) continue;
      if (latest === undefined || seconds > latest) latest = seconds;
    }
  }
  return latest;
}

function normalizeIconUrl(value: unknown): string | undefined {
  const iconPath = optionalString(value, 512);
  if (!iconPath) return undefined;
  // Steam commonly appends a safe render suffix such as `/360fx360f`.
  // Keep the source as a relative economy-image path so it cannot override the
  // pinned CDN origin or smuggle credentials/query parameters.
  if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(iconPath)) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path: '$.description.icon_url' });
  }
  const url = new URL(
    iconPath,
    'https://community.cloudflare.steamstatic.com/economy/image/',
  );
  if (url.origin !== 'https://community.cloudflare.steamstatic.com' ||
      !url.pathname.startsWith('/economy/image/') || url.search || url.hash) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', { path: '$.description.icon_url' });
  }
  return url.href;
}

function normalizeMarketName(description: Record<string, unknown>): string {
  const value = optionalString(description['market_hash_name'], 240) ??
    optionalString(description['name'], 240);
  if (!value) {
    throw new GatewayPayloadError('INVALID_PAYLOAD', {
      path: '$.description.market_hash_name',
    });
  }
  return value;
}

/**
 * Description fields the offers page renders. Anything outside this list stays
 * out of the message, so the page read cannot quietly grow into a full dump of
 * Steam's payload.
 */
const DISPLAY_DESCRIPTION_FIELDS = [
  'name',
  'market_hash_name',
  'name_color',
  'type',
  'icon_url',
  'tradable',
  'marketable',
  'tags',
  'descriptions',
  'owner_descriptions',
] as const;

type MutableDisplayItem = {
  -readonly [K in keyof SteamOfferDisplayItem]: SteamOfferDisplayItem[K];
};

function readDisplayItems(
  value: unknown,
  descriptions: Map<string, Record<string, unknown>>,
  path: string,
): SteamOfferDisplayItem[] {
  // Every row is kept, including non-CS2 ones: the page finds an item by its
  // index inside the offer, so skipping a row shifts every overlay after it
  // onto the wrong tile.
  return asArray(value).map((entry, position) => {
    const asset = asRecord(entry, `${path}[${position}]`);
    const classId = optionalString(asset['classid'], 32) ?? '';
    const instanceId = optionalString(asset['instanceid'], 32) ?? '0';
    const item: MutableDisplayItem = {
      appid: optionalString(asset['appid'], 10) ?? '',
      contextid: optionalString(asset['contextid'], 10) ?? '2',
      assetid: optionalString(asset['assetid'], 32) ?? '',
      classid: classId,
      instanceid: instanceId,
      amount: optionalString(asset['amount'], 12) ?? '1',
      position,
    };
    const description = descriptions.get(`${classId}:${instanceId}`);
    if (description) {
      // Written through an index view: the field list spans several value
      // types, so a direct keyed assignment narrows to their intersection.
      const writable = item as Record<string, unknown>;
      for (const field of DISPLAY_DESCRIPTION_FIELDS) {
        const raw = description[field];
        if (raw !== undefined) writable[field] = raw;
      }
    }
    return item;
  });
}

function normalizeTradeItem(
  value: unknown,
  descriptions: Map<string, Record<string, unknown>>,
  path: string,
  direction: 'given' | 'received',
): PortfolioTradeItemDto | null {
  const asset = asRecord(value, path);
  const appId = optionalString(asset['appid'], 10) ?? '730';
  if (appId !== '730') return null;
  const classId = requiredDigits(asset['classid'], `${path}.classid`);
  const instanceId = requiredDigits(asset['instanceid'] ?? '0', `${path}.instanceid`);
  const description = descriptions.get(`${classId}:${instanceId}`);
  const iconUrl = description ? normalizeIconUrl(description['icon_url']) : undefined;
  const newAssetId = direction === 'received'
    ? optionalString(asset['new_assetid'], 32)
    : undefined;
  const newContextId = direction === 'received'
    ? optionalString(asset['new_contextid'], 4)
    : undefined;
  // Steam changes an asset's identity when ownership moves. Use the new pair
  // atomically for received items so it matches the current inventory; a
  // malformed or incomplete pair falls back to the original identity.
  const useReceivedIdentity = newAssetId !== undefined && newContextId !== undefined &&
    /^[0-9]{1,32}$/.test(newAssetId) && /^[0-9]{1,4}$/.test(newContextId);
  return {
    appId: '730',
    contextId: useReceivedIdentity
      ? newContextId
      : requiredDigits(asset['contextid'] ?? '2', `${path}.contextid`, 4),
    assetId: useReceivedIdentity
      ? newAssetId
      : requiredDigits(asset['assetid'], `${path}.assetid`),
    classId,
    instanceId,
    amount: requiredDigits(asset['amount'] ?? '1', `${path}.amount`),
    ...(description ? { marketHashName: normalizeMarketName(description) } : {}),
    ...(iconUrl ? { iconUrl } : {}),
  };
}

function normalizeTradeItems(
  value: unknown,
  descriptions: Map<string, Record<string, unknown>>,
  path: string,
  direction: 'given' | 'received',
): readonly PortfolioTradeItemDto[] {
  return asArray(value)
    .map((entry, index) => normalizeTradeItem(
      entry,
      descriptions,
      `${path}[${index}]`,
      direction,
    ))
    .filter((entry): entry is PortfolioTradeItemDto => entry !== null);
}

class BrowserSteamReadSessionProvider implements SteamReadSessionProvider {
  private memoryToken: MemoryToken | null = null;
  private pendingToken: Promise<string> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly requestFirstPartyCredential?: SteamReadSessionProviderOptions[
    'requestFirstPartyCredential'
  ];

  constructor(private readonly steamId: string, options: SteamReadSessionProviderOptions) {
    assertSteamId64(steamId);
    // 🔴 `fetch` must keep its global receiver. Stored bare and invoked as
    // `this.fetchImpl(...)` the service worker rejects every call with
    // "Illegal invocation": `this` is the instance, not WorkerGlobalScope.
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.requestFirstPartyCredential = options.requestFirstPartyCredential;
  }

  offerAccessToken(token: string, tokenSteamId: string): void {
    // A token minted for a different Steam account would read that account's
    // trades and offers while every row we store says this one. Refuse rather
    // than mix identities.
    if (tokenSteamId !== this.steamId) return;
    const normalized = token.replace(/&quot;/g, '').replace(/"/g, '').trim();
    if (normalized.length < 16 || normalized.length > 4_096 || /\s/.test(normalized)) return;
    this.memoryToken = { value: normalized, mintedAt: this.now() };
  }

  hasUsableAccessToken(): boolean {
    return this.memoryToken !== null &&
      this.now() - this.memoryToken.mintedAt < TOKEN_MEMORY_TTL_MS;
  }

  forgetSession(): void {
    this.memoryToken = null;
  }

  async refreshAccessToken(): Promise<void> {
    const firstParty = await this.requestFirstPartyCredential?.();
    if (firstParty) {
      this.offerAccessToken(firstParty.token, firstParty.steamId);
      if (this.hasUsableAccessToken()) return;
    }
    await this.getAccessToken(true);
  }

  private async mintAccessToken(): Promise<string> {
    const response = await this.fetchImpl(STEAM_TOKEN_PAGE, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      headers: { Accept: 'text/html' },
    });
    if (!response.ok) {
      throw new GatewayPayloadError('INVALID_PAYLOAD', {
        reason: 'steam-session-unavailable',
        status: response.status,
      });
    }
    let responseOrigin: string;
    try {
      responseOrigin = new URL(response.url).origin;
    } catch {
      throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'steam-session-unavailable' });
    }
    if (responseOrigin !== 'https://steamcommunity.com') {
      throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'steam-session-unavailable' });
    }
    const html = await response.text();
    // The token belongs to whichever account the browser is signed into right
    // now, while every read below passes `this.steamId`. Traders switch Steam
    // accounts mid-session, and the offer/trade reads carry no steamid at all —
    // they are simply "whoever the token belongs to". Without this check that
    // second account's history is filed under the first one's id.
    const sessionSteamId = /g_steamID\s*=\s*"(\d+)"/.exec(html)?.[1];
    if (sessionSteamId && sessionSteamId !== this.steamId) {
      throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'steam-account-mismatch' });
    }
    const raw = /data-loyalty_webapi_token\s*=\s*"([^"]+)"/.exec(html)?.[1];
    const token = raw?.replace(/&quot;/g, '').replace(/"/g, '').trim();
    if (!token || token.length < 16 || token.length > 4_096 || /\s/.test(token)) {
      throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'steam-session-unavailable' });
    }
    this.memoryToken = { value: token, mintedAt: this.now() };
    return token;
  }

  private async getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.memoryToken &&
        this.now() - this.memoryToken.mintedAt < TOKEN_MEMORY_TTL_MS) {
      return this.memoryToken.value;
    }
    if (!this.pendingToken) {
      this.pendingToken = this.mintAccessToken().finally(() => {
        this.pendingToken = null;
      });
    }
    return this.pendingToken;
  }

  private async fetchSteamApi(
    method: 'GetInventoryItemsWithDescriptions' | 'GetTradeHistory' | 'GetTradeOffers',
    params: Readonly<Record<string, string>>,
  ): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt === 1) await this.refreshAccessToken();
      const token = await this.getAccessToken();
      const query = new URLSearchParams({ ...params, access_token: token });
      const response = await this.fetchImpl(`${STEAM_API_ROOT}/${method}/v1/?${query}`, {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        headers: { Accept: 'application/json' },
      });
      if ((response.status === 401 || response.status === 403) && attempt === 0) {
        // Keep the page-derived credential in memory until a replacement has
        // actually been minted. The forced second attempt bypasses it; retaining
        // it only prevents a failed cross-site mint from destroying the sole
        // first-party proof before a Steam page can offer a fresh token.
        continue;
      }
      if (!response.ok) {
        throw new GatewayPayloadError('INVALID_PAYLOAD', {
          reason: 'steam-read-failed',
          status: response.status,
        });
      }
      return readResponseRoot(await response.json());
    }
    throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'steam-session-unavailable' });
  }

  async readInventoryContext(contextId: SteamInventoryContextId): Promise<SteamInventoryReadResult> {
    if (contextId !== '2' && contextId !== '16') {
      throw new GatewayPayloadError('INVALID_PAYLOAD', { path: '$.contextId' });
    }
    const items: PortfolioItemDto[] = [];
    let startAssetId: string | undefined;

    for (let page = 0; page < MAX_INVENTORY_PAGES; page += 1) {
      const response = await this.fetchSteamApi('GetInventoryItemsWithDescriptions', {
        steamid: this.steamId,
        appid: '730',
        contextid: contextId,
        get_descriptions: 'true',
        get_asset_properties: 'true',
        for_trade_offer_verification: 'true',
        language: 'english',
        count: '2000',
        ...(startAssetId ? { start_assetid: startAssetId } : {}),
      });
      const descriptions = buildDescriptionMap(asArray(response['descriptions']));
      const properties = buildAssetPropertiesMap(response['asset_properties']);

      for (const [index, entry] of asArray(response['assets']).entries()) {
        const asset = asRecord(entry, `$.assets[${index}]`);
        const assetId = requiredDigits(asset['assetid'], `$.assets[${index}].assetid`);
        const classId = requiredDigits(asset['classid'], `$.assets[${index}].classid`);
        const instanceId = requiredDigits(
          asset['instanceid'] ?? '0',
          `$.assets[${index}].instanceid`,
        );
        const description = descriptions.get(`${classId}:${instanceId}`);
        if (!description) {
          throw new GatewayPayloadError('INVALID_PAYLOAD', {
            path: `$.assets[${index}]`,
            reason: 'missing-description',
          });
        }
        const property = properties.get(assetId);
        const { floatValue, paintSeed, defIndex, paintIndex } =
          parseSteamAssetProperties(property);
        const tradable = Number(description['tradable']) === 1;
        const marketable = Number(description['marketable']) === 1;
        const tradableAfter = optionalInteger(
          property?.['tradable_after'] ?? asset['tradable_after'],
        ) ?? tradableAfterFromOwnerDescriptions(description);
        const name = optionalString(description['name'], 240);
        const iconUrl = normalizeIconUrl(description['icon_url']);
        items.push({
          appId: '730',
          contextId,
          assetId,
          classId,
          instanceId,
          amount: requiredDigits(asset['amount'] ?? '1', `$.assets[${index}].amount`),
          marketHashName: normalizeMarketName(description),
          ...(name ? { name } : {}),
          ...(iconUrl ? { iconUrl } : {}),
          tradable,
          marketable,
          onHold: contextId === '16' ||
            (tradableAfter !== undefined && tradableAfter > Math.floor(this.now() / 1_000)),
          ...(tradableAfter !== undefined ? { tradableAfter } : {}),
          ...(floatValue !== undefined ? { floatValue } : {}),
          ...(paintSeed !== undefined ? { paintSeed } : {}),
          ...(defIndex !== undefined ? { defIndex } : {}),
          ...(paintIndex !== undefined ? { paintIndex } : {}),
        });
      }

      const moreItems = response['more_items'] === true || Number(response['more_items']) === 1;
      if (!moreItems) return { contextId, complete: true, items };
      const nextAssetId = optionalString(response['last_assetid'], 32);
      if (!nextAssetId || nextAssetId === startAssetId || !/^[0-9]+$/.test(nextAssetId)) {
        throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'inventory-pagination-invalid' });
      }
      startAssetId = nextAssetId;
    }
    throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'inventory-pagination-limit' });
  }

  /** One history row, strictly. Callers decide whether a bad row is fatal. */
  private readTradeRowStrict(
    entry: unknown,
    index: number,
    descriptions: ReturnType<typeof buildDescriptionMap>,
  ): PortfolioTradeDto {
    const trade = asRecord(entry, `$.trades[${index}]`);
    const partnerSteamId = requiredDigits(
      trade['steamid_other'],
      `$.trades[${index}].steamid_other`,
      20,
    );
    assertSteamId64(partnerSteamId);
    const occurredAt = optionalInteger(trade['time_init']);
    if (!occurredAt || occurredAt <= 0) {
      throw new GatewayPayloadError('INVALID_PAYLOAD', {
        path: `$.trades[${index}].time_init`,
      });
    }
    return {
      tradeId: requiredDigits(trade['tradeid'], `$.trades[${index}].tradeid`),
      partnerSteamId,
      occurredAt,
      itemsGiven: normalizeTradeItems(
        trade['assets_given'],
        descriptions,
        `$.trades[${index}].assets_given`,
        'given',
      ),
      itemsReceived: normalizeTradeItems(
        trade['assets_received'],
        descriptions,
        `$.trades[${index}].assets_received`,
        'received',
      ),
    };
  }

  async readRecentTrades(
    maxTrades = 100,
    options: SteamTradesReadOptions = {},
  ): Promise<SteamTradesReadResult> {
    /*
      250, not 100, and the ceiling is OURS rather than Steam's.

      `GetTradeHistory` serves 250 happily — CSFloat's extension has asked for
      exactly that on a three-minute alarm for as long as it has existed. Our
      cap was 100 and the P2P tracker asked for 200, so `readRecentTrades` threw
      INVALID_PAYLOAD before making a single request, on EVERY pass, and the
      trade-history half of the tracker had never once run. That is why the
      reversal detection built on it has been blind, and why exactly one of the
      46 P2P orders taken in ten days has any history row against it.

      The number matters beyond fixing the throw: a hundred rows is a busy
      trader's afternoon, and the window this has to cover is Steam's seven-day
      protection period — the whole time a buyer can still reverse the trade.
    */
    if (!Number.isSafeInteger(maxTrades) || maxTrades < 1 || maxTrades > 250) {
      throw new GatewayPayloadError('INVALID_PAYLOAD', { path: '$.maxTrades' });
    }
    const cursor = options.cursor;
    if (cursor && (
      !Number.isSafeInteger(cursor.startAfterTime) || cursor.startAfterTime <= 0 ||
      cursor.startAfterTime > 0xffff_ffff ||
      !/^[0-9]{1,20}$/.test(cursor.startAfterTradeId)
    )) {
      throw new GatewayPayloadError('INVALID_PAYLOAD', { path: '$.tradeHistoryCursor' });
    }
    const wantDescriptions = options.getDescriptions !== false;
    const response = await this.fetchSteamApi('GetTradeHistory', {
      max_trades: String(maxTrades),
      get_descriptions: wantDescriptions ? 'true' : 'false',
      include_failed: 'false',
      include_total: options.includeTotal ? 'true' : 'false',
      language: 'english',
      navigating_back: 'false',
      ...(cursor ? {
        start_after_time: String(cursor.startAfterTime),
        start_after_tradeid: cursor.startAfterTradeId,
      } : {}),
    });
    const descriptions = buildDescriptionMap(asArray(response['descriptions']));
    const skipUnreadable = options.skipUnreadableRows === true;
    const trades = asArray(response['trades']).flatMap((entry, index): PortfolioTradeDto[] => {
      try {
        return [this.readTradeRowStrict(entry, index, descriptions)];
      } catch (error) {
        if (!skipUnreadable) throw error;
        return [];
      }
    });
    const icons: Record<string, string> = {};
    const nameColors: Record<string, string> = {};
    // Status per trade, by the same id the DTO carries — see `statuses`.
    const statuses: Record<string, number> = {};
    for (const [index, entry] of asArray(response['trades']).entries()) {
      const trade = asRecord(entry, `$.trades[${index}]`);
      const tradeId = optionalString(trade['tradeid'], 32);
      const status = optionalInteger(trade['status']);
      if (tradeId && status !== undefined) statuses[tradeId] = status;
    }
    for (const [key, description] of descriptions) {
      const iconUrl = normalizeIconUrl(description['icon_url']);
      // Steam's economy CDN resizes on request. Without a size suffix it serves
      // the original, which is ~100 KB per item — hundreds of them on one
      // history page. `96fx96f` covers a 40px slot at 2x for a few KB.
      if (iconUrl) icons[key] = /\/\d+f?x\d+f?$/.test(iconUrl) ? iconUrl : `${iconUrl}/96fx96f`;
      const color = optionalString(description['name_color'], 8);
      // Steam sends a bare hex triplet. Anything else is dropped rather than
      // interpolated into a style attribute.
      if (color && /^[0-9a-fA-F]{6}$/.test(color)) nameColors[key] = `#${color}`;
    }
    // Steam can hand back more rows than `max_trades`, and the DTO caps the run
    // at the same number — one extra row failed the whole sync with a
    // record-limit rejection. Offers were already sliced here; trades were not.
    const totalTrades = optionalInteger(response['total_trades']);
    const hasMore = response['more'] === true || Number(response['more']) === 1;
    return {
      complete: true,
      trades: trades.slice(0, maxTrades),
      icons,
      nameColors,
      statuses,
      hasMore,
      ...(totalTrades !== undefined ? { totalTrades } : {}),
    };
  }

  async readTradeOffers(): Promise<SteamOffersReadResult> {
    // Steam returns every offer ever made unless told otherwise. For one real
    // account that was 333 offers, most of them years-dead, and the payload it
    // produced is pure waste: a portfolio only cares about what is live or
    // recently settled. `time_historical_cutoff` bounds the historical half.
    const historicalCutoff = Math.floor(
      (this.now() - OFFER_HISTORY_WINDOW_MS) / 1_000,
    );
    const response = await this.fetchSteamApi('GetTradeOffers', {
      get_received_offers: '1',
      get_sent_offers: '1',
      active_only: '0',
      historical_only: '0',
      time_historical_cutoff: String(historicalCutoff),
      get_descriptions: '1',
      language: 'english',
    });
    const descriptions = buildDescriptionMap(asArray(response['descriptions']));
    const normalizeOffers = (
      value: unknown,
      direction: PortfolioOfferDto['direction'],
    ): PortfolioOfferDto[] => asArray(value).flatMap((entry, index): PortfolioOfferDto[] => {
      const path = direction === 'sent' ? '$.trade_offers_sent' : '$.trade_offers_received';
      const offer = asRecord(entry, `${path}[${index}]`);
      const state = optionalInteger(offer['trade_offer_state']);
      if (!state || state > 32) {
        throw new GatewayPayloadError('INVALID_PAYLOAD', { path: `${path}[${index}]` });
      }
      // Portfolio sync is a record of item movement, so only accepted offers
      // belong here. This gate is also a privacy boundary: notes, trade ids,
      // counterparties and item arrays on live/declined/cancelled offers must
      // never be inspected or classified by the portfolio path.
      if (state !== 3) return [];
      const createdAt = optionalInteger(offer['time_created']);
      if (!createdAt) {
        throw new GatewayPayloadError('INVALID_PAYLOAD', { path: `${path}[${index}]` });
      }
      const completedTradeId = optionalString(offer['tradeid'], 32);
      const marketplaceHint = marketplaceHintFromOfferMessage(offer['message']);
      const expiresAt = optionalPortfolioTimestamp(offer['expiration_time']);
      const escrowEndAt = optionalPortfolioTimestamp(offer['escrow_end_date']);
      return [{
        offerId: requiredDigits(offer['tradeofferid'], `${path}[${index}].tradeofferid`),
        direction,
        partnerAccountId: requiredDigits(
          offer['accountid_other'],
          `${path}[${index}].accountid_other`,
          12,
        ),
        state,
        createdAt,
        ...(completedTradeId !== undefined ? {
          completedTradeId: requiredDigits(
            completedTradeId,
            `${path}[${index}].tradeid`,
          ),
        } : {}),
        ...(marketplaceHint !== undefined ? { marketplaceHint } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(escrowEndAt !== undefined ? { escrowEndAt } : {}),
        itemsToGive: normalizeTradeItems(
          offer['items_to_give'],
          descriptions,
          `${path}[${index}].items_to_give`,
          'given',
        ),
        itemsToReceive: normalizeTradeItems(
          offer['items_to_receive'],
          descriptions,
          `${path}[${index}].items_to_receive`,
          'received',
        ),
      }];
    });
    const normalized = [
      ...normalizeOffers(response['trade_offers_received'], 'received'),
      ...normalizeOffers(response['trade_offers_sent'], 'sent'),
    ].sort(newestOfferFirst);
    const truncated = normalized.length > MAX_PORTFOLIO_OFFERS_PER_RUN;
    return {
      complete: true,
      offers: normalized.slice(0, MAX_PORTFOLIO_OFFERS_PER_RUN),
      ...(truncated ? { warningCode: STEAM_OFFERS_TRUNCATED_WARNING } : {}),
    };
  }

  /**
   * Page-facing sibling of `readTradeOffers`. Deliberately separate: the
   * portfolio read is strict (it throws on an odd row, caps the run and drops
   * non-CS2 items) because a malformed sync is worse than no sync. On the page
   * the opposite holds — one strange offer must not blank out prices, stickers
   * and rarity colours for the whole list, so this read skips what it cannot
   * parse and keeps going. The credential still never leaves the provider.
   */
  async readTradeOffersForDisplay(
    options: SteamOffersDisplayReadOptions = {},
  ): Promise<SteamOffersDisplayReadResult> {
    // Settled offers still sit on the page (declined, cancelled), and they
    // carried overlays before, so the historical half stays in — bounded by the
    // same window the portfolio read uses rather than Steam's full history.
    const historicalCutoff = Math.floor(
      (this.now() - OFFER_HISTORY_WINDOW_MS) / 1_000,
    );
    const response = await this.fetchSteamApi('GetTradeOffers', {
      get_received_offers: options.received === false ? '0' : '1',
      get_sent_offers: options.sent === false ? '0' : '1',
      active_only: options.activeOnly ? '1' : '0',
      historical_only: '0',
      ...(options.activeOnly
        ? {}
        : { time_historical_cutoff: String(historicalCutoff) }),
      get_descriptions: '1',
      language: 'english',
    });
    const descriptions = buildDescriptionMap(asArray(response['descriptions']));

    const readOffers = (
      value: unknown,
      direction: 'sent' | 'received',
    ): SteamOfferDisplayOffer[] => {
      const path = `$.trade_offers_${direction}`;
      return asArray(value).flatMap((entry, index) => {
        const offer = asRecord(entry, `${path}[${index}]`);
        const offerId = optionalString(offer['tradeofferid'], 32);
        // The page keys every overlay off the DOM id `tradeofferid_<id>`.
        // Without a usable id there is nothing to attach to.
        if (!offerId || !/^[0-9]+$/.test(offerId)) return [];
        return [{
          tradeofferid: offerId,
          accountid_other: optionalString(offer['accountid_other'], 12) ?? '',
          trade_offer_state: optionalInteger(offer['trade_offer_state']) ?? 0,
          time_created: optionalInteger(offer['time_created']) ?? 0,
          ...(optionalInteger(offer['expiration_time']) !== undefined
            ? { expiration_time: optionalInteger(offer['expiration_time']) }
            : {}),
          ...(optionalInteger(offer['escrow_end_date']) !== undefined
            ? { escrow_end_date: optionalInteger(offer['escrow_end_date']) }
            : {}),
          direction,
          items_to_give: readDisplayItems(
            offer['items_to_give'],
            descriptions,
            `${path}[${index}].items_to_give`,
          ),
          items_to_receive: readDisplayItems(
            offer['items_to_receive'],
            descriptions,
            `${path}[${index}].items_to_receive`,
          ),
        }];
      });
    };

    return {
      complete: true,
      offers: [
        ...readOffers(response['trade_offers_received'], 'received'),
        ...readOffers(response['trade_offers_sent'], 'sent'),
      ],
    };
  }
}

export function createSteamReadSessionProvider(
  options: SteamReadSessionProviderOptions,
): SteamReadSessionProvider {
  return new BrowserSteamReadSessionProvider(options.steamId, options);
}
