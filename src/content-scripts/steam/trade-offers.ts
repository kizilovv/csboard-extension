// ============================================================
// CSBOARD Content Script — Steam Trade Offers List Page
// ============================================================
// Injected on: steamcommunity.com/*/tradeoffers*
//
// Architecture: fixed internal read-provider approach
// 1. Ask the background for normalized offers (no credential in messages)
// 2. Background's private provider injects its memory-only credential
// 3. Background returns items with market_hash_name from descriptions
// 4. Match items to DOM elements by classid/instanceid/side/position
// 5. Look up prices from priceEngine, display overlays
//
// Also: Override ShowTradeOffer to open in new tab

import { priceEngine } from '../../shared/price-engine';
import { createLogger, describeError } from '../../shared/logger';
import { injectScript, injectStyle } from '../../shared/inject';
import { addSSTandExtIndicators, makeItemColorful, addFloatIndicator, addDopplerPhase, addPatternIndicator, getBuffLink, buildCsfloatSearchUrl } from '../../shared/items';
import { getPattern } from '../../shared/patternDetector';
import { getDopplerInfo } from '../../shared/dopplerPhases';
import { readSteamPageCredential } from '../../shared/steam-page-credential';
import { sendMessageIfContextAlive } from '../../shared/message-bus';
import { whenSiteEnabled } from '../../shared/enhancements';
import {
  fetchInventoryAssetProperties,
  hasAnyProperty,
  readCachedAssetProperties,
  rememberAssetProperties,
} from '../../shared/steam-inventory-properties';
import type { ParsedSteamAssetProperties } from '../../shared/steam-asset-properties';
import { markScamOffersOnList } from './p2p-scam-warning';
import { offerItemPrice, valueOffer } from '../../shared/offer-valuation';

const logger = createLogger('trade-offers-list');

// ============================================================
// Page type detection (cs2trader pattern)
// ============================================================

type PageType = 'incoming_offers' | 'sent_offers';

function detectPageType(): PageType {
  if (window.location.href.includes('/tradeoffers/sent')) return 'sent_offers';
  return 'incoming_offers';
}

const activePage = detectPageType();

// ============================================================
// ShowTradeOffer Override (injectScriptAsFile — bypass Steam CSP)
// ============================================================

function injectShowTradeOfferOverride() {
  const existingEl = document.getElementById('csboard-ShowTradeOffer');
  if (existingEl) existingEl.remove();

  const script = document.createElement('script');
  script.id = 'csboard-ShowTradeOffer';
  script.src = chrome.runtime.getURL('injectToPage/ShowTradeOffer.js');
  (document.head || document.documentElement).appendChild(script);
  logger.info('ShowTradeOffer override injected via file');
}

// ============================================================
// Item → DOM matching (cs2trader: findItem + getLimitedIDsFromElement)
// ============================================================

interface LimitedIDs {
  appid: string | null;
  classid: string | null;
  instanceid: string | null;
}

function getLimitedIDsFromElement(el: Element): LimitedIDs {
  const dataAttr = el.getAttribute('data-economy-item') || '';
  const parts = dataAttr.split('/');
  return {
    appid: parts[1] ?? null,
    classid: parts[2] ?? null,
    instanceid: parts[3] ?? null,
  };
}

interface SteamItem {
  appid: number | string;
  assetid?: string;
  classid: string;
  instanceid: string;
  position: number;
  side: 'your' | 'their';
  inOffer: string;
  offerOrigin: 'sent' | 'received';
  /** Steam account id (32-bit) of the trade partner, from the offers read. */
  accountid_other?: number;
  market_hash_name?: string;
  name?: string;
  type?: string;
  tags?: any[];
  icon_url?: string;
  floatValue?: number | null;
  paintSeed?: number | null;
  defIndex?: number | null;
  paintIndex?: number | null;
  [key: string]: unknown;
}

// Partner float reads: one Steam inventory request per partner, ~650ms each
// whatever the inventory's size, so the pacing that matters is how many run at
// once. Three abreast measured clean on Steam; the gap keeps a long scroll
// under roughly four reads a second. The budget is a page-load ceiling, not a
// target — normally only the offers the user scrolls to are ever read.
const PARTNER_ATTRIBUTE = 'data-csboard-partner';
const PARTNER_READ_CONCURRENCY = 3;
const PARTNER_READ_GAP_MS = 150;
const PARTNER_THROTTLE_BACKOFF_MS = 20_000;
const MAX_PARTNER_READS = 80;
/* A prefetched read keeps the partner's whole inventory in memory, because the
   offer's asset ids are not known yet. This bounds that to a few megabytes. */
const MAX_TRACKED_PROPERTIES = 20_000;
const MAX_THROTTLE_STRIKES = 3;
const CACHE_WRITE_DEBOUNCE_MS = 2_000;

const STEAM_ID64_BASE = BigInt('76561197960265728');

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const steamId64FromAccountId = (accountId: unknown): string | null => {
  const numeric = Number(accountId);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) return null;
  return (STEAM_ID64_BASE + BigInt(numeric)).toString();
};

/** The background's inventory read already parsed properties; reshape only. */
const normalizeProviderProperties = (apiItem: {
  floatValue?: unknown;
  paintSeed?: unknown;
  defIndex?: unknown;
  paintIndex?: unknown;
}): ParsedSteamAssetProperties => {
  const bounded = (value: unknown): number | undefined => {
    const numeric = value === null || value === undefined || value === '' ? Number.NaN : Number(value);
    return Number.isFinite(numeric) && numeric >= 0 && numeric <= 1 ? numeric : undefined;
  };
  const whole = (value: unknown): number | undefined => {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : undefined;
  };
  return {
    floatValue: bounded(apiItem.floatValue),
    paintSeed: whole(apiItem.paintSeed),
    defIndex: whole(apiItem.defIndex),
    paintIndex: whole(apiItem.paintIndex),
  };
};

const buildCsfloatUrlForOfferItem = (item: SteamItem): string => {
  const marketHashName = item.market_hash_name || item.name || '';
  const dopplerPhase = item.icon_url ? getDopplerInfo(item.icon_url)?.name : undefined;
  return buildCsfloatSearchUrl({
    assetId: item.assetid,
    marketHashName,
    defIndex: item.defIndex,
    paintIndex: item.paintIndex,
    paintSeed: item.paintSeed,
    floatValue: item.floatValue,
    dopplerPhase,
    itemType: item.type,
    tags: item.tags,
  });
};

function findItem(
  items: SteamItem[],
  ids: LimitedIDs,
  side: string,
  position: number,
  offerId: string | null,
): SteamItem | undefined {
  return items.find((item) => {
    if (String(item.appid) !== ids.appid || item.classid !== ids.classid) return false;
    if (ids.instanceid !== null && item.instanceid !== ids.instanceid) return false;
    if (item.position !== position || item.side !== side) return false;
    return offerId === null || item.inOffer === offerId;
  });
}

// ============================================================
// Trade Offers List Script
// ============================================================

class TradeOffersListScript {
  private initialized = false;

  /** Asset id → wear/pattern, from cache, our inventory or a partner's. */
  private assetProperties = new Map<string, ParsedSteamAssetProperties>();
  /** Asset ids that came out of storage — re-persisting them is a wasted write. */
  private cachedAssetIds = new Set<string>();
  private pendingCacheWrites = new Map<string, ParsedSteamAssetProperties>();
  private partnerObserver: IntersectionObserver | null = null;
  private cacheWriteTimer: number | null = null;
  private theirItemsByPartner = new Map<string, SteamItem[]>();
  private partnerQueue: string[] = [];
  private queuedPartners = new Set<string>();
  private activePartnerWorkers = 0;
  private partnerBudget = MAX_PARTNER_READS;
  private throttleStrikes = 0;
  /** Shared deadline: one worker being throttled pauses all of them. */
  private backoffUntil = 0;

  async init() {
    if (this.initialized) return;
    this.initialized = true;

    logger.info('Initializing trade offers list page', { activePage });

    // 1. Init price engine
    await priceEngine.init();
    logger.info('Price engine ready', {
      loaded: priceEngine.isLoaded,
      itemCount: priceEngine.itemCount,
    });

    // 2. cs2trader: make secondary side items larger (96x96 instead of 73x73)
    // This is the key visual change that makes cards look "bigger"
    this.makeLargerItems();

    // 3. Inject ShowTradeOffer override
    injectShowTradeOfferOverride();

    // 3.5. Start reading partner inventories NOW. Steam's own trade-offers API
    // answers in 1.5-4s, and until this ran after it, every partner float was
    // stuck behind that. The page's avatars already carry the partner account
    // ids, which is all a read needs — the offer's asset ids only decide which
    // of the results get drawn.
    this.prefetchPartnersFromPage();

    // 4. Fetch trade offers via the background's fixed read provider.
    try {
      const response = await this.fetchTradeOffers();
      if (!response || !response.items) {
        logger.warn('No items returned from Steam API');
        return;
      }

      logger.info('Trade offers received from API', {
        items: response.items.length,
        received: response.offers.trade_offers_received?.length || 0,
        sent: response.offers.trade_offers_sent?.length || 0,
      });

      // 5. Add item info to DOM (prices on each item)
      this.addItemInfo(response.items);

      // 6. Add offer totals (P/L per offer)
      if (activePage === 'incoming_offers') {
        this.addOfferTotals(response.offers.trade_offers_received || [], response.items);
      } else {
        this.addOfferTotals(response.offers.trade_offers_sent || [], response.items);
      }
      // 7. Add quick decline buttons (cs2trader: quickDeclineOffer)
      this.addQuickAcceptAndDeclineButtons();

      // 8. Enrich with float data (async)
      this.enrichWithFloat(response.items).catch((err) => {
        logger.warn(`Float enrichment failed: ${describeError(err)}`);
      });
    } catch (err) {
      // Steam data is an enhancement, not a precondition. Losing it used to
      // abort init() and leave the page with no prices, no rarity colours and
      // no links at all — a total blackout caused by one failed request.
      logger.error(`Failed to fetch trade offers: ${describeError(err)}`);
      this.addQuickAcceptAndDeclineButtons();
    }
  }

  // --- cs2trader: make items larger (96x96) ---
  // "Makes your own items' icon larger - making it the same size as
  //  the other party's items at the trade offers page."

  private makeLargerItems() {
    // Inject CSS to resize secondary (your) side items to 96x96
    injectStyle(`
      .tradeoffer_items.secondary .trade_item {
        width: 96px !important;
        height: 96px !important;
        margin-right: 8px;
        margin-bottom: 8px;
      }
    `, 'csboard-items-same-size');

    // Replace icon URLs: 73x73 → 96x96 for HD images
    document.querySelectorAll('.tradeoffer_items.secondary').forEach((secondaryEl) => {
      secondaryEl.querySelectorAll('.trade_item').forEach((itemEl) => {
        const iconEl = itemEl.querySelector('img');
        if (iconEl) {
          if (iconEl.src) iconEl.src = iconEl.src.replace('73fx73f', '96fx96f');
          const srcset = iconEl.getAttribute('srcset');
          if (srcset) iconEl.setAttribute('srcset', srcset.replace('73fx73f', '96fx96f'));
        }
      });
    });

    logger.info('Items resized to 96x96');
  }

  // --- Fetch via background ---

  private fetchTradeOffers(): Promise<{
    offers: {
      trade_offers_received: any[];
      trade_offers_sent: any[];
    };
    items: SteamItem[];
  }> {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: 'FETCH_STEAM_TRADE_OFFERS',
          data: {
            activesOnly: 1,
            sent: 1,
            received: 1,
            // First-party credential from this page's own DOM; the worker
            // cannot always mint one (blocked third-party cookies).
            ...(readSteamPageCredential() ?? {}),
          },
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError.message);
            return;
          }
          if (response?.error) {
            reject(response.error);
            return;
          }
          resolve(response);
        }
      );
    });
  }

  // --- Add price indicators to each item element (cs2trader: addItemInfo) ---

  private addItemInfo(items: SteamItem[]) {
    const activeItemElements: Array<{ el: Element; side: string; position: number }> = [];

    document.querySelectorAll('[id^="tradeofferid_"]').forEach((offerEl) => {
      // Skip inactive offers
      const ctn = offerEl.querySelector('.tradeoffer_items_ctn');
      if (ctn?.classList.contains('inactive')) return;

      const primary = offerEl.querySelector('.tradeoffer_items.primary');
      const secondary = offerEl.querySelector('.tradeoffer_items.secondary');
      if (!primary || !secondary) return;

      // cs2trader: on incoming page, primary = their side, secondary = your side
      // on sent page, primary = your side, secondary = their side
      const theirSide = activePage === 'incoming_offers' ? primary : secondary;
      const yourSide = activePage === 'incoming_offers' ? secondary : primary;

      [...yourSide.querySelectorAll('.trade_item')].forEach((el, index) => {
        activeItemElements.push({ el, side: 'your', position: index });
      });

      [...theirSide.querySelectorAll('.trade_item')].forEach((el, index) => {
        activeItemElements.push({ el, side: 'their', position: index });
      });
    });

    logger.info('Matching items to DOM elements', { domItems: activeItemElements.length, apiItems: items.length });

    for (const { el, side, position } of activeItemElements) {
      if (el.getAttribute('data-processed') === 'true') continue;

      // Remove CSFloat elements
      [...el.children].forEach(child => {
        if (child.tagName && child.tagName.toLowerCase().startsWith('csfloat')) child.remove();
      });

      const ids = getLimitedIDsFromElement(el);
      const offerContainer = el.closest<HTMLElement>('[id^="tradeofferid_"]');
      const offerId = offerContainer?.id.replace(/^tradeofferid_/, '') || null;
      const item = findItem(items, ids, side, position, offerId);

      if (item && item.market_hash_name) {
        // Doppler phase-specific pricing
        const dopplerInfo = item.icon_url ? getDopplerInfo(item.icon_url as string) : null;
        const dopplerPhase = dopplerInfo?.name;

        const price = priceEngine.getPrice(item.market_hash_name, dopplerPhase);

        if (price) {
          el.insertAdjacentHTML('beforeend', `<div class="priceIndicator">${price.display}</div>`);
        }

        // cs2trader: colored backgrounds by rarity, doppler gets phase color
        makeItemColorful(el as HTMLElement, item.tags as any[] | undefined, undefined, item.market_hash_name, item.icon_url as string | undefined);

        // Exterior + StatTrak/Souvenir + sticker price (top-right)
        const isStatrack = (item.name || item.market_hash_name || '').includes('StatTrak');
        const isSouvenir = (item.name || item.market_hash_name || '').includes('Souvenir');

        // Parse sticker total from descriptions
        let stickerTotal = 0;
        const descs = item.descriptions as any[] | undefined;
        if (descs) {
          for (const d of descs) {
            if (d && (d.name === 'sticker_info' || d.name === 'keychain_info')) {
              const val = d.value || '';
              const afterBr = val.split('><br>')[1];
              if (!afterBr) continue;
              const afterColon = afterBr.split(': ')[1];
              if (!afterColon) continue;
              const nameStr = afterColon.split('</center>')[0];
              const names = nameStr.split(', ');
              const prefix = d.name === 'sticker_info' ? 'Sticker' : 'Charm';
              for (const n of names) {
                const sp = priceEngine.getPrice(`${prefix} | ${n.trim()}`);
                if (sp) stickerTotal += sp.raw;
              }
            }
          }
        }

        addSSTandExtIndicators(el as HTMLElement, {
          isStatrack,
          isSouvenir,
          tags: item.tags as any[] | undefined,
          // The normalized offer read carries no Steam tag list, so the wear
          // badge falls back to the name, which always spells it out.
          marketHashName: item.market_hash_name as string | undefined,
          stickerTotal,
        });

        // Doppler phase badge
        addDopplerPhase(el as HTMLElement, item.icon_url as string | undefined);

        // Pattern indicator (fade %, marble fade, case hardened blue %)
        // paintSeed comes from enrichment (propertyid=1), may be null on list page
        const pSeed = typeof item.paintSeed === 'number' ? item.paintSeed : null;
        const patternInfo = getPattern(item.market_hash_name, pSeed);
        addPatternIndicator(el as HTMLElement, patternInfo);

        el.setAttribute('data-market-hash-name', item.market_hash_name);

        // Add marketplace links (BUFF, CSFloat) — inject into Steam's popup
        const linksHtml = `
          <a class="csboard-item-link" href="${getBuffLink(item.market_hash_name)}" target="_blank" rel="noopener noreferrer">BUFF</a>
          <a class="csboard-item-link csboard-csfloat-link" href="${buildCsfloatUrlForOfferItem(item)}" target="_blank" rel="noopener noreferrer">CSFloat</a>
        `;
        el.insertAdjacentHTML('beforeend', `<div class="csboard-item-links">${linksHtml}</div>`);
      }

      el.setAttribute('data-processed', 'true');
    }
  }

  // --- Add P/L totals per offer (cs2trader: addTotals) ---

  private addOfferTotals(offers: any[], items: SteamItem[]) {
    let activeOfferCount = 0;
    let totalProfit = 0;
    let profitableOffers = 0;

    const settings = priceEngine.getSettings();
    const sign = settings.currency === 'USD' ? '$' : settings.currency;

    for (const offer of offers) {
      const offerEl = document.getElementById(`tradeofferid_${offer.tradeofferid}`);
      if (!offerEl) continue;

      // Skip inactive
      const ctn = offerEl.querySelector('.tradeoffer_items_ctn');
      if (ctn?.classList.contains('inactive')) continue;

      // Skip if already processed
      if (offerEl.querySelector('.profitOrLoss')) continue;

      activeOfferCount++;

      // Calculate totals. Shared with the scam warnings, which must call a
      // trade a loss exactly when this badge does: see shared/offer-valuation.
      const value = valueOffer(
        offer as { items_to_give?: SteamItem[]; items_to_receive?: SteamItem[] },
        (item) => offerItemPrice(item, items, (name, phase) => priceEngine.getPrice(name, phase)),
      );
      const yourTotal = value.give.total;
      const theirTotal = value.receive.total;
      const yourNoPrice = value.give.unpriced;
      const theirNoPrice = value.receive.unpriced;

      const profitLoss = theirTotal - yourTotal;
      const plBase = yourTotal > 0 ? yourTotal : theirTotal;
      const plPercent = plBase > 0 ? ((profitLoss / plBase) * 100) : 0;
      const isProfit = profitLoss > 0.5;
      const isLoss = profitLoss < -0.5;
      const plSign = profitLoss > 0 ? '+' : '';
      const pctSign = plPercent > 0 ? '+' : '';

      if (isProfit) {
        totalProfit += profitLoss;
        profitableOffers++;
      }

      // P/L badge — cs2trader exact: .profitOrLoss at top-right of .tradeoffer_items_ctn
      // Black background, colored text (green=profit, red=loss)
      const plColorClass = isProfit ? 'profit' : isLoss ? 'loss' : '';
      const badge = document.createElement('span');
      badge.className = `profitOrLoss contrastingBackground ${plColorClass}`;
      badge.setAttribute('data-profit-or-loss', String(profitLoss));
      badge.setAttribute('data-receiving-total', String(theirTotal));
      badge.setAttribute('data-giving-total', String(yourTotal));
      badge.setAttribute('data-p-l-percentage', String(plPercent));
      badge.setAttribute('data-updated', String(offer.time_updated || 0));
      badge.textContent = `${plSign}${sign}${profitLoss.toFixed(2)} ${pctSign}${plPercent.toFixed(1)}%`;
      if (yourNoPrice || theirNoPrice) badge.textContent += ' *';

      if (ctn) {
        // Make ctn position:relative for absolute positioning of badge
        (ctn as HTMLElement).style.position = 'relative';
        ctn.insertAdjacentElement('afterbegin', badge);
      } else {
        offerEl.insertAdjacentElement('afterbegin', badge);
      }

      logger.debug('Offer totals added', {
        offerId: offer.tradeofferid,
        give: yourTotal.toFixed(2),
        get: theirTotal.toFixed(2),
        pl: profitLoss.toFixed(2),
        pct: plPercent.toFixed(1),
      });
    }

    // --- Global summary above trades tab (cs2trader: #tradeoffers_summary) ---
    this.addGlobalSummary(activeOfferCount, profitableOffers, totalProfit, sign);
  }

  // --- Global summary at top of page ---

  private addGlobalSummary(activeCount: number, profitableCount: number, totalProfit: number, sign: string) {
    if (document.getElementById('csboard-trades-summary')) return;

    const summary = document.createElement('div');
    summary.id = 'csboard-trades-summary';
    summary.innerHTML = `
      <span class="csboard-logo" style="font-size:12px;">CSBOARD</span>
      <span class="csboard-summary-item">Active: <strong>${activeCount}</strong></span>
      <span class="csboard-summary-sep">|</span>
      <span class="csboard-summary-item">Profitable: <strong class="csboard-summary-green">${profitableCount}</strong></span>
      <span class="csboard-summary-sep">|</span>
      <span class="csboard-summary-item">Potential profit: <strong class="csboard-summary-green">${sign}${totalProfit.toFixed(2)}</strong></span>
      <select id="csboard-offer-sort" class="csboard-sort-dropdown">
        <option value="default">Sort: Default</option>
        <option value="profit_amount">Most profitable</option>
        <option value="loss_amount">Most losing</option>
        <option value="profit_pct">Highest % profit</option>
        <option value="loss_pct">Highest % loss</option>
        <option value="receiving_value">Highest receiving</option>
        <option value="giving_value">Highest giving</option>
      </select>
      <button id="csboard-save-sort" class="csboard-save-sort" title="Save as my default sorting">Save</button>
      <button id="csboard-trade-history-btn" class="csboard-trade-history-btn" title="Open Trade History">Trade History</button>
    `;

    const leftCol = document.querySelector('.profile_leftcol');
    if (leftCol) {
      const firstOffer = leftCol.querySelector('.tradeoffer');
      if (firstOffer) {
        firstOffer.insertAdjacentElement('beforebegin', summary);
      } else {
        leftCol.insertAdjacentElement('afterbegin', summary);
      }
    }

    // Sorting listener
    const sortSelect = document.getElementById('csboard-offer-sort') as HTMLSelectElement | null;
    sortSelect?.addEventListener('change', () => {
      this.sortOffers(sortSelect.value);
    });

    // Save sort button
    const saveBtn = document.getElementById('csboard-save-sort');
    saveBtn?.addEventListener('click', () => {
      if (sortSelect) {
        chrome.storage.local.set({ csboard_default_sort_offers: sortSelect.value });
        saveBtn.textContent = 'Saved!';
        saveBtn.classList.add('saved');
        setTimeout(() => {
          saveBtn.textContent = 'Save';
          saveBtn.classList.remove('saved');
        }, 2000);
      }
    });

    // Trade History button
    document.getElementById('csboard-trade-history-btn')?.addEventListener('click', () => {
      sendMessageIfContextAlive({ type: 'OPEN_TRADE_HISTORY' });
    });

    // Load saved default sort
    if (sortSelect) {
      chrome.storage.local.get('csboard_default_sort_offers', (data) => {
        const saved = data['csboard_default_sort_offers'];
        if (saved && sortSelect) {
          sortSelect.value = saved;
          this.sortOffers(saved);
        }
      });
    }
  }

  // --- Quick decline (cs2trader: quickDeclineOffer) ---
  // Replaces Steam's confirm-dialog decline with instant API call

  // --- Enrich items with float via Steam APIs ---
  //
  // Our side comes from the token-backed inventory read. The partner's side
  // used to be left blank here on the theory that a partner inventory needs
  // trade-page context — it does not: the public community inventory endpoint
  // serves `asset_properties` for any profile. See steam-inventory-properties.
  private async enrichWithFloat(items: SteamItem[]) {
    // Get our steamid
    const steamIdScript = "document.querySelector('body').setAttribute('mySteamId', typeof g_steamID !== 'undefined' ? g_steamID : '');";
    const mySteamId = injectScript(steamIdScript, true, 'getMySteamId', 'mySteamId');

    // A float never changes, so an asset id read on an earlier visit costs
    // Steam nothing now. This is what keeps a page reload from re-reading
    // every partner's inventory.
    try {
      const cached = await readCachedAssetProperties();
      for (const [assetId, parsed] of cached) {
        this.cachedAssetIds.add(assetId);
        if (!this.assetProperties.has(assetId)) this.assetProperties.set(assetId, parsed);
      }
    } catch (err) {
      logger.warn(`Could not read the asset property cache: ${describeError(err)}`);
    }

    // 1. Partner items: match the reads already in flight to the offer's items,
    // and watch the rest of the page for what still has to be read.
    let enriched = this.scheduleTheirFloats(items);

    // 2. Our items — GetInventoryItemsWithDescriptions
    if (mySteamId) {
      try {
        const result = await new Promise<any>((resolve, reject) => {
          chrome.runtime.sendMessage(
            {
              type: 'FETCH_INVENTORY_WITH_PROPERTIES',
              data: { steamId: mySteamId, ...(readSteamPageCredential() ?? {}) },
            },
            (resp) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message ?? 'message port closed'));
                return;
              }
              if (resp?.error) { reject(new Error(describeError(resp.error))); return; }
              resolve(resp);
            }
          );
        });
        if (result?.items) {
          for (const apiItem of result.items) {
            const assetId = String(apiItem?.assetid ?? '');
            if (!assetId) continue;
            const parsed = normalizeProviderProperties(apiItem);
            if (hasAnyProperty(parsed)) this.assetProperties.set(assetId, parsed);
          }
          enriched += this.applyKnownProperties(items.filter((item) => item.side === 'your'));
          logger.info('Enriched OUR items on list', { apiItems: result.items.length, enriched });
        }
      } catch (err) {
        logger.warn(`Failed to enrich our items on list: ${describeError(err)}`);
      }
    }

    if (enriched > 0) {
      logger.info('Float enrichment on trade offers list complete', { enriched });
    }
  }

  // --- Partner floats -------------------------------------------------
  // Every partner is one Steam inventory request, and Steam answers those at
  // roughly four a second no matter how many run at once — so the reads are
  // queued, and only for the offers the user actually reaches.

  /**
   * Queue the partners whose offers are on screen, straight from the page.
   * This runs before the offers API answers, which is the whole point: the
   * account id in each offer's avatar is enough to start reading.
   */
  private prefetchPartnersFromPage() {
    const observer = this.watchOffersForPartners();
    let watched = 0;

    for (const offerEl of document.querySelectorAll<HTMLElement>('[id^="tradeofferid_"]')) {
      const ctn = offerEl.querySelector('.tradeoffer_items_ctn');
      if (!ctn || ctn.classList.contains('inactive')) continue;

      const accountId = offerEl.querySelector('.playerAvatar')?.getAttribute('data-miniprofile');
      const partnerId = steamId64FromAccountId(accountId);
      if (!partnerId) continue;

      offerEl.setAttribute(PARTNER_ATTRIBUTE, partnerId);
      observer.observe(offerEl);
      watched += 1;
    }

    logger.info('Watching offers for partner floats', { offers: watched });
  }

  private watchOffersForPartners(): IntersectionObserver {
    if (this.partnerObserver) return this.partnerObserver;

    this.partnerObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        this.partnerObserver?.unobserve(entry.target);
        const partnerId = entry.target.getAttribute(PARTNER_ATTRIBUTE);
        if (partnerId) this.enqueuePartner(partnerId);
      }
      // Read a screen ahead of the scroll, so a float is already there by the
      // time the offer is actually looked at.
    }, { rootMargin: '800px' });

    return this.partnerObserver;
  }

  /** Bind the offers API's items to their partner, then draw what is known. */
  private scheduleTheirFloats(items: SteamItem[]): number {
    for (const item of items) {
      if (item.side !== 'their') continue;
      if (!String(item.assetid ?? '')) continue;

      const partnerId = steamId64FromAccountId(item.accountid_other);
      // No element means the offer is inactive or gone; nothing to draw on.
      if (!partnerId || !this.findItemElement(item)) continue;

      const bucket = this.theirItemsByPartner.get(partnerId);
      if (bucket) bucket.push(item);
      else this.theirItemsByPartner.set(partnerId, [item]);
    }

    return this.applyKnownProperties(items);
  }

  private enqueuePartner(partnerId: string) {
    if (this.queuedPartners.has(partnerId)) return;
    this.queuedPartners.add(partnerId);
    this.partnerQueue.push(partnerId);
    this.runPartnerQueue();
  }

  private runPartnerQueue() {
    while (this.activePartnerWorkers < PARTNER_READ_CONCURRENCY &&
           this.partnerQueue.length > 0 &&
           this.partnerBudget > 0) {
      this.activePartnerWorkers += 1;
      void this.readPartnerQueue();
    }
  }

  private async readPartnerQueue() {
    try {
      while (this.partnerQueue.length > 0 && this.partnerBudget > 0) {
        const waitMs = this.backoffUntil - Date.now();
        if (waitMs > 0) await delay(waitMs);

        const partnerId = this.partnerQueue.shift();
        if (!partnerId) continue;

        this.partnerBudget -= 1;
        const outcome = await fetchInventoryAssetProperties(partnerId);

        if (outcome.status === 'throttled') {
          // Steam asked us to slow down. The partner keeps its place in line
          // and every worker waits — retrying now only digs deeper.
          this.partnerQueue.unshift(partnerId);
          this.partnerBudget += 1;
          this.throttleStrikes += 1;
          if (this.throttleStrikes > MAX_THROTTLE_STRIKES) {
            logger.warn('Steam keeps throttling inventory reads; partner floats stop here');
            this.partnerQueue.length = 0;
            break;
          }
          this.backoffUntil = Date.now() + PARTNER_THROTTLE_BACKOFF_MS;
          continue;
        }

        if (outcome.status === 'ok') {
          // Held in memory for the whole inventory; only the asset ids that
          // end up drawn on an offer are written to storage.
          for (const [assetId, parsed] of outcome.properties) {
            if (this.assetProperties.size >= MAX_TRACKED_PROPERTIES) break;
            if (!this.assetProperties.has(assetId)) this.assetProperties.set(assetId, parsed);
          }
          const drawn = this.applyKnownProperties(this.theirItemsByPartner.get(partnerId) ?? []);
          logger.info('Enriched PARTNER items on list', {
            partnerId, properties: outcome.properties.size, drawn,
          });
        } else {
          // Private profile or a hard failure — asking again would repeat it.
          logger.info('Partner inventory unavailable', { partnerId, status: outcome.status });
        }

        await delay(PARTNER_READ_GAP_MS);
      }
    } finally {
      this.activePartnerWorkers -= 1;
    }
  }

  private schedulePropertyCacheWrite() {
    if (this.cacheWriteTimer !== null) return;
    this.cacheWriteTimer = window.setTimeout(() => {
      this.cacheWriteTimer = null;
      const pending = new Map(this.pendingCacheWrites);
      this.pendingCacheWrites.clear();
      rememberAssetProperties(pending).catch((err) => {
        logger.warn(`Could not persist asset properties: ${describeError(err)}`);
      });
    }, CACHE_WRITE_DEBOUNCE_MS);
  }

  /** Draw every property already known for these items. Returns floats drawn. */
  private applyKnownProperties(items: SteamItem[]): number {
    let drawn = 0;
    for (const item of items) {
      const assetId = String(item.assetid ?? '');
      if (!assetId) continue;
      const parsed = this.assetProperties.get(assetId);
      if (!parsed) continue;
      if (this.applyItemProperties(item, parsed)) drawn += 1;
    }
    return drawn;
  }

  private applyItemProperties(item: SteamItem, parsed: ParsedSteamAssetProperties): boolean {
    const el = this.findItemElement(item) as HTMLElement | null;
    if (!el) return false;

    if (parsed.floatValue !== undefined) item.floatValue = parsed.floatValue;
    if (parsed.paintSeed !== undefined) item.paintSeed = parsed.paintSeed;
    if (parsed.defIndex !== undefined) item.defIndex = parsed.defIndex;
    if (parsed.paintIndex !== undefined) item.paintIndex = parsed.paintIndex;

    const alreadyDrawn = el.querySelector('.floatIndicator') !== null;
    addFloatIndicator(el, item.floatValue, 4);
    const drewFloat = !alreadyDrawn && el.querySelector('.floatIndicator') !== null;

    // The seed only arrives with this enrichment, so the pattern badge that
    // addItemInfo could not compute is filled in now.
    if (typeof item.paintSeed === 'number' && item.market_hash_name) {
      addPatternIndicator(el, getPattern(item.market_hash_name, item.paintSeed));
    }

    const csfloatLink = el.querySelector<HTMLAnchorElement>('.csboard-csfloat-link');
    if (csfloatLink) csfloatLink.href = buildCsfloatUrlForOfferItem(item);

    const assetId = String(item.assetid ?? '');
    if (assetId && !this.cachedAssetIds.has(assetId)) {
      this.pendingCacheWrites.set(assetId, parsed);
      this.schedulePropertyCacheWrite();
    }

    return drewFloat;
  }

  // Find DOM element for a trade offer item
  private findItemElement(item: SteamItem): Element | null {
    const offerEl = document.getElementById(`tradeofferid_${item.inOffer}`);
    if (!offerEl) return null;
    const side = item.side === 'your'
      ? (activePage === 'incoming_offers' ? '.tradeoffer_items.secondary' : '.tradeoffer_items.primary')
      : (activePage === 'incoming_offers' ? '.tradeoffer_items.primary' : '.tradeoffer_items.secondary');
    const sideEl = offerEl.querySelector(side);
    if (!sideEl) return null;
    const tradeItems = sideEl.querySelectorAll('.trade_item');
    return tradeItems[item.position] || null;
  }

  private addQuickAcceptAndDeclineButtons() {
    const sessionIdScript = "document.querySelector('body').setAttribute('sessionid', typeof g_sessionID !== 'undefined' ? g_sessionID : '');";
    const sessionId = injectScript(sessionIdScript, true, 'getSessionID', 'sessionid');

    if (!sessionId) {
      logger.warn('Could not get session ID');
      return;
    }

    document.querySelectorAll('.tradeoffer').forEach((offerElement) => {
      const ctn = offerElement.querySelector('.tradeoffer_items_ctn');
      if (!ctn || ctn.classList.contains('inactive')) return;

      const footerActions = offerElement.querySelector('.tradeoffer_footer_actions');
      if (!footerActions) return;

      // Extract offer ID from decline button href
      const declineLink = footerActions.querySelector('a.whiteLink[href*="DeclineTradeOffer"]') as HTMLElement;
      const offerIdMatch = declineLink?.getAttribute('href')?.match(/['"](\d+)['"]/);
      if (!offerIdMatch) return;
      const tradeOfferId = offerIdMatch[1];

      // Get partner ID from avatar miniprofile
      const partnerMiniProfile = offerElement.querySelector('.playerAvatar')?.getAttribute('data-miniprofile') || '';
      // Convert miniprofile (accountid) to Steam64
      const partnerSteam64 = partnerMiniProfile ? (BigInt(partnerMiniProfile) + BigInt('76561197960265728')).toString() : '';

      // --- Accept button (cs2trader exact) ---
      if (activePage === 'incoming_offers') {
        footerActions.insertAdjacentHTML('afterbegin',
          `<span id="csboard_accept_${tradeOfferId}" class="whiteLink" style="cursor:pointer; color:#90ba3c; font-weight:bold;">Accept Trade</span> | `
        );

        document.getElementById(`csboard_accept_${tradeOfferId}`)?.addEventListener('click', () => {
          const offerContent = offerElement.querySelector('.tradeoffer_items_ctn');
          const middleEl = offerContent?.querySelector('.tradeoffer_items_rule');

          fetch(`https://steamcommunity.com/tradeoffer/${tradeOfferId}/accept`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            referrer: `https://steamcommunity.com/tradeoffer/${tradeOfferId}/`,
            body: `sessionid=${sessionId}&serverid=1&tradeofferid=${tradeOfferId}&partner=${partnerSteam64}&captcha=`,
          }).then(resp => {
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return resp.json();
          }).then(body => {
            let msg = 'Trade Accepted';
            if (body.needs_email_confirmation || body.needs_mobile_confirmation) {
              msg = 'Accepted - Awaiting Confirmation';
            }
            offerElement.querySelector('.tradeoffer_footer')?.setAttribute('style', 'display:none');
            if (offerContent) { offerContent.classList.remove('active'); offerContent.classList.add('inactive'); }
            if (middleEl) {
              middleEl.classList.remove('tradeoffer_items_rule');
              middleEl.classList.add('tradeoffer_items_banner');
              (middleEl as HTMLElement).style.height = '';
              (middleEl as HTMLElement).innerText = msg;
            }
          }).catch(() => {
            alert('Could not accept trade offer. Steam may be having issues.');
          });
        });
      }

      // --- Quick decline (replace Steam's confirm dialog) ---
      if (declineLink) {
        const declineText = declineLink.innerText;
        declineLink.remove();
        const newBtn = document.createElement('span');
        newBtn.classList.add('whiteLink');
        newBtn.style.cssText = 'cursor:pointer; color:#c6d4df;';
        newBtn.innerText = declineText;
        footerActions.appendChild(newBtn);

        newBtn.addEventListener('click', () => {
          fetch(`https://steamcommunity.com/tradeoffer/${tradeOfferId}/decline`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: `sessionid=${sessionId}`,
          }).then((response) => {
            if (response.ok) {
              offerElement.querySelector('.tradeoffer_footer')?.setAttribute('style', 'display:none');
              if (ctn) { ctn.classList.remove('active'); ctn.classList.add('inactive'); }
              const middleEl = ctn?.querySelector('.tradeoffer_items_rule');
              if (middleEl) {
                middleEl.classList.remove('tradeoffer_items_rule');
                middleEl.classList.add('tradeoffer_items_banner');
                (middleEl as HTMLElement).style.height = '';
                (middleEl as HTMLElement).innerText = 'Trade Declined';
              }
            } else {
              alert('Could not decline offer. Steam may be having issues.');
            }
          }).catch(() => {
            alert('Could not decline offer. Steam may be having issues.');
          });
        });
      }
    });

    logger.info('Accept & decline buttons added');
  }

  // --- Sort offers (cs2trader: sortOffers) ---

  private sortOffers(mode: string) {
    const activeOffers = [...document.querySelectorAll('.tradeoffer')].filter((el) => {
      const ctn = el.querySelector('.tradeoffer_items_ctn');
      return ctn && !ctn.classList.contains('inactive');
    });

    if (activeOffers.length === 0) return;

    const getAttr = (el: Element, attr: string) => parseFloat(el.querySelector('.profitOrLoss')?.getAttribute(attr) || '0');

    let sorted: Element[];
    switch (mode) {
      case 'profit_amount':
        sorted = activeOffers.sort((a, b) => getAttr(b, 'data-profit-or-loss') - getAttr(a, 'data-profit-or-loss'));
        break;
      case 'loss_amount':
        sorted = activeOffers.sort((a, b) => getAttr(a, 'data-profit-or-loss') - getAttr(b, 'data-profit-or-loss'));
        break;
      case 'profit_pct':
        sorted = activeOffers.sort((a, b) => getAttr(b, 'data-p-l-percentage') - getAttr(a, 'data-p-l-percentage'));
        break;
      case 'loss_pct':
        sorted = activeOffers.sort((a, b) => getAttr(a, 'data-p-l-percentage') - getAttr(b, 'data-p-l-percentage'));
        break;
      case 'receiving_value':
        sorted = activeOffers.sort((a, b) => getAttr(b, 'data-receiving-total') - getAttr(a, 'data-receiving-total'));
        break;
      case 'giving_value':
        sorted = activeOffers.sort((a, b) => getAttr(b, 'data-giving-total') - getAttr(a, 'data-giving-total'));
        break;
      default:
        sorted = activeOffers.sort((a, b) => getAttr(b, 'data-updated') - getAttr(a, 'data-updated'));
        break;
    }

    // Remove rulers between offers
    const leftCol = document.querySelector('.profile_leftcol');
    if (!leftCol) return;
    leftCol.querySelectorAll('.tradeoffer_rule').forEach((r) => r.remove());

    // Remove then re-insert sorted offers
    sorted.forEach((el) => el.remove());
    const insertBefore = leftCol.querySelector('.tradeoffer') || leftCol.querySelector('#tradeoffers_btn_more');
    sorted.forEach((offerEl) => {
      if (insertBefore) {
        insertBefore.insertAdjacentElement('beforebegin', offerEl);
      } else {
        leftCol.appendChild(offerEl);
      }
    });
  }
}

// ============================================================
// Init
// ============================================================

const script = new TradeOffersListScript();

function init() {
  script.init().catch((err) => {
    logger.error('Failed to initialize trade offers list', { error: String(err) });
  });
}

/* The master switch is checked here, once, before anything is drawn. */
const bootstrap = () => { init(); };

/*
  The scam warning starts OUTSIDE the switch: it guards a sold skin, not a
  decoration. See p2p-scam-warning.ts.
*/
const startScamGuard = () => { markScamOffersOnList(); };

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    startScamGuard();
    whenSiteEnabled('steam', bootstrap);
  });
} else {
  startScamGuard();
  whenSiteEnabled('steam', bootstrap);
}
