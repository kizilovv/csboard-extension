import {
  GatewayPayloadError,
  MAX_PORTFOLIO_OFFERS_PER_RUN,
  assertSteamId64,
  type PortfolioItemDto,
  type PortfolioOfferDto,
  type PortfolioTradeDto,
  type PortfolioTradeItemDto,
  type SteamInventoryContextId,
} from '../shared/gateway-dto';

const STEAM_API_ROOT = 'https://api.steampowered.com/IEconService';
const STEAM_TOKEN_PAGE = 'https://steamcommunity.com/my/tradehistory?l=english';
const MAX_INVENTORY_PAGES = 20;
const TOKEN_MEMORY_TTL_MS = 5 * 60 * 1_000;
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
  /**
   * Icon per `classId:instanceId`, kept OUTSIDE the trade DTO on purpose: that
   * DTO is what the gateway uploads and the server validates strictly, so an
   * extra field there turns into a rejected sync. Local views need the picture,
   * the gateway does not.
   */
  readonly icons: Readonly<Record<string, string>>;
  /** Steam rarity colour per `classId:instanceId`, same reasoning as icons. */
  readonly nameColors: Readonly<Record<string, string>>;
}

export interface SteamOffersReadResult {
  readonly complete: true;
  readonly offers: readonly PortfolioOfferDto[];
  /** Safe status only; no discarded offer fields cross this boundary. */
  readonly warningCode?: typeof STEAM_OFFERS_TRUNCATED_WARNING;
}

/**
 * What the trade-offers PAGE needs, which is a different set from what the
 * gateway uploads. `PortfolioTradeItemDto` keeps ids plus a market name and
 * drops everything else on purpose; the page reads `descriptions` for sticker
 * and charm rows, `tags` for rarity/exterior colouring and `icon_url` for the
 * Doppler phase. Feeding the page the portfolio DTO silently zeroed all three.
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
  readRecentTrades(maxTrades?: number): Promise<SteamTradesReadResult>;
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
  forgetSession(): void;
}

export interface SteamReadSessionProviderOptions {
  readonly steamId: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
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

function optionalFiniteNumber(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
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
): PortfolioTradeItemDto | null {
  const asset = asRecord(value, path);
  const appId = optionalString(asset['appid'], 10) ?? '730';
  if (appId !== '730') return null;
  const classId = requiredDigits(asset['classid'], `${path}.classid`);
  const instanceId = requiredDigits(asset['instanceid'] ?? '0', `${path}.instanceid`);
  const description = descriptions.get(`${classId}:${instanceId}`);
  return {
    appId: '730',
    contextId: requiredDigits(asset['contextid'] ?? '2', `${path}.contextid`, 4),
    assetId: requiredDigits(asset['assetid'], `${path}.assetid`),
    classId,
    instanceId,
    amount: requiredDigits(asset['amount'] ?? '1', `${path}.amount`),
    ...(description ? { marketHashName: normalizeMarketName(description) } : {}),
  };
}

function normalizeTradeItems(
  value: unknown,
  descriptions: Map<string, Record<string, unknown>>,
  path: string,
): readonly PortfolioTradeItemDto[] {
  return asArray(value)
    .map((entry, index) => normalizeTradeItem(entry, descriptions, `${path}[${index}]`))
    .filter((entry): entry is PortfolioTradeItemDto => entry !== null);
}

class BrowserSteamReadSessionProvider implements SteamReadSessionProvider {
  private memoryToken: MemoryToken | null = null;
  private pendingToken: Promise<string> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly steamId: string, options: SteamReadSessionProviderOptions) {
    assertSteamId64(steamId);
    // 🔴 `fetch` must keep its global receiver. Stored bare and invoked as
    // `this.fetchImpl(...)` the service worker rejects every call with
    // "Illegal invocation": `this` is the instance, not WorkerGlobalScope.
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
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

  forgetSession(): void {
    this.memoryToken = null;
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
      const token = await this.getAccessToken(attempt === 1);
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
        this.forgetSession();
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
      const properties = new Map<string, Record<string, unknown>>();
      for (const entry of asArray(response['asset_properties'])) {
        const property = asRecord(entry, '$.asset_properties[]');
        const assetId = optionalString(property['assetid'], 32);
        if (assetId && /^[0-9]+$/.test(assetId)) properties.set(assetId, property);
      }

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
        let floatValue: number | undefined;
        let paintSeed: number | undefined;
        for (const rawProperty of asArray(property?.['asset_properties'])) {
          const itemProperty = asRecord(rawProperty, '$.asset_properties[].asset_properties[]');
          const propertyId = optionalInteger(itemProperty['propertyid']);
          if (propertyId === 1) paintSeed = optionalInteger(itemProperty['int_value']);
          if (propertyId === 2) floatValue = optionalFiniteNumber(itemProperty['float_value']);
        }
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

  async readRecentTrades(maxTrades = 100): Promise<SteamTradesReadResult> {
    if (!Number.isSafeInteger(maxTrades) || maxTrades < 1 || maxTrades > 100) {
      throw new GatewayPayloadError('INVALID_PAYLOAD', { path: '$.maxTrades' });
    }
    const response = await this.fetchSteamApi('GetTradeHistory', {
      max_trades: String(maxTrades),
      get_descriptions: 'true',
      include_total: 'false',
      language: 'english',
    });
    const descriptions = buildDescriptionMap(asArray(response['descriptions']));
    const trades = asArray(response['trades']).map((entry, index): PortfolioTradeDto => {
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
        ),
        itemsReceived: normalizeTradeItems(
          trade['assets_received'],
          descriptions,
          `$.trades[${index}].assets_received`,
        ),
      };
    });
    const icons: Record<string, string> = {};
    const nameColors: Record<string, string> = {};
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
    return { complete: true, trades: trades.slice(0, maxTrades), icons, nameColors };
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
    ): PortfolioOfferDto[] => asArray(value).map((entry, index) => {
      const path = direction === 'sent' ? '$.trade_offers_sent' : '$.trade_offers_received';
      const offer = asRecord(entry, `${path}[${index}]`);
      const state = optionalInteger(offer['trade_offer_state']);
      const createdAt = optionalInteger(offer['time_created']);
      if (!state || state > 32 || !createdAt) {
        throw new GatewayPayloadError('INVALID_PAYLOAD', { path: `${path}[${index}]` });
      }
      return {
        offerId: requiredDigits(offer['tradeofferid'], `${path}[${index}].tradeofferid`),
        direction,
        partnerAccountId: requiredDigits(
          offer['accountid_other'],
          `${path}[${index}].accountid_other`,
          12,
        ),
        state,
        createdAt,
        ...(optionalInteger(offer['expiration_time']) !== undefined ? {
          expiresAt: optionalInteger(offer['expiration_time']),
        } : {}),
        ...(optionalInteger(offer['escrow_end_date']) !== undefined ? {
          escrowEndAt: optionalInteger(offer['escrow_end_date']),
        } : {}),
        itemsToGive: normalizeTradeItems(
          offer['items_to_give'],
          descriptions,
          `${path}[${index}].items_to_give`,
        ),
        itemsToReceive: normalizeTradeItems(
          offer['items_to_receive'],
          descriptions,
          `${path}[${index}].items_to_receive`,
        ),
      };
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
