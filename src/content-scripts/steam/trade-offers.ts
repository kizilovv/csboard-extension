// ============================================================
// CSBOARD Content Script — Steam Trade Offers List Page
// ============================================================
// Injected on: steamcommunity.com/*/tradeoffers*
//
// Architecture: cs2trader approach
// 1. Read data-loyalty_webapi_token from #application_config
// 2. Send token to background → IEconService/GetTradeOffers/v1
// 3. Background returns items with market_hash_name from descriptions
// 4. Match items to DOM elements by classid/instanceid/side/position
// 5. Look up prices from priceEngine, display overlays
//
// Also: Override ShowTradeOffer to open in new tab

import { priceEngine } from '../../shared/price-engine';
import { createLogger } from '../../shared/logger';
import { injectScript, injectStyle } from '../../shared/inject';
import { addSSTandExtIndicators, makeItemColorful, addFloatIndicator, addDopplerPhase, addPatternIndicator, getBuffLink, getCsFloatLink } from '../../shared/items';
import { getPattern } from '../../shared/patternDetector';
import { getDopplerInfo } from '../../shared/dopplerPhases';

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
// Steam Access Token (cs2trader: refreshSteamAccessToken)
// ============================================================
// Reads data-loyalty_webapi_token from #application_config DOM element.
// This is a DOM attribute, accessible from content scripts.

function getSteamAccessToken(): string | null {
  const token = document.getElementById('application_config')
    ?.getAttribute('data-loyalty_webapi_token')
    ?.replace(/"/g, '');

  if (!token) {
    logger.warn('Steam access token not found in #application_config');
    return null;
  }

  logger.debug('Steam access token found', { length: token.length });
  return token;
}

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
  classid: string;
  instanceid: string;
  position: number;
  side: 'your' | 'their';
  inOffer: string;
  offerOrigin: 'sent' | 'received';
  market_hash_name?: string;
  name?: string;
  [key: string]: unknown;
}

function findItem(items: SteamItem[], ids: LimitedIDs, side: string, position: number): SteamItem | undefined {
  if (ids.instanceid !== null) {
    return items.find(
      (item) =>
        String(item.appid) === ids.appid &&
        item.classid === ids.classid &&
        item.instanceid === ids.instanceid &&
        item.position === position &&
        item.side === side
    );
  }
  return items.find((item) => item.classid === ids.classid);
}

// ============================================================
// Trade Offers List Script
// ============================================================

class TradeOffersListScript {
  private initialized = false;

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

    // 4. Get Steam access token from page
    const accessToken = getSteamAccessToken();
    if (!accessToken) {
      logger.error('Cannot fetch trade offers: no access token');
      return;
    }

    // 4. Fetch trade offers via background (IEconService API)
    try {
      const response = await this.fetchTradeOffers(accessToken);
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
      this.enrichWithFloat(response.items).catch(err => {
        logger.warn('Float enrichment failed', { error: String(err) });
      });
    } catch (err) {
      logger.error('Failed to fetch trade offers', { error: String(err) });
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

  private fetchTradeOffers(accessToken: string): Promise<{
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
          data: { accessToken, activesOnly: 1, sent: 1, received: 1 },
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
      const item = findItem(items, ids, side, position);

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

        // Add marketplace links (BUFF, CSFloat, Pricempire) — inject into Steam's popup
        const linksHtml = `
          <a class="csboard-item-link" href="${getBuffLink(item.market_hash_name)}" target="_blank">BUFF</a>
          <a class="csboard-item-link" href="${getCsFloatLink(item.market_hash_name)}" target="_blank">CSFloat</a>
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

      // Calculate totals
      let yourTotal = 0;
      let theirTotal = 0;
      let yourNoPrice = false;
      let theirNoPrice = false;

      if (offer.items_to_give) {
        for (const item of offer.items_to_give) {
          const desc = items.find(
            (i) => i.classid === item.classid && i.instanceid === item.instanceid
          );
          if (desc?.market_hash_name) {
            const dp = desc.icon_url ? getDopplerInfo(desc.icon_url as string)?.name : undefined;
            const price = priceEngine.getPrice(desc.market_hash_name, dp);
            if (price) yourTotal += price.raw;
            else yourNoPrice = true;
          } else {
            yourNoPrice = true;
          }
        }
      }

      if (offer.items_to_receive) {
        for (const item of offer.items_to_receive) {
          const desc = items.find(
            (i) => i.classid === item.classid && i.instanceid === item.instanceid
          );
          if (desc?.market_hash_name) {
            const dp = desc.icon_url ? getDopplerInfo(desc.icon_url as string)?.name : undefined;
            const price = priceEngine.getPrice(desc.market_hash_name, dp);
            if (price) theirTotal += price.raw;
            else theirNoPrice = true;
          } else {
            theirNoPrice = true;
          }
        }
      }

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
      chrome.runtime.sendMessage({ type: 'OPEN_TRADE_HISTORY' });
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
  private async enrichWithFloat(items: SteamItem[]) {
    const accessToken = getSteamAccessToken();
    if (!accessToken) return;

    // Get our steamid
    const steamIdScript = "document.querySelector('body').setAttribute('mySteamId', typeof g_steamID !== 'undefined' ? g_steamID : '');";
    const mySteamId = injectScript(steamIdScript, true, 'getMySteamId', 'mySteamId');

    let enriched = 0;

    // 1. Our items — GetInventoryItemsWithDescriptions
    if (mySteamId) {
      try {
        const result = await new Promise<any>((resolve, reject) => {
          chrome.runtime.sendMessage(
            { type: 'FETCH_INVENTORY_WITH_PROPERTIES', data: { accessToken, steamId: mySteamId } },
            (resp) => {
              if (chrome.runtime.lastError) { reject(chrome.runtime.lastError.message); return; }
              if (resp?.error) { reject(resp.error); return; }
              resolve(resp);
            }
          );
        });
        if (result?.items) {
          const floatMap: Record<string, { fv: number; ps: number }> = {};
          for (const apiItem of result.items) {
            if (apiItem.floatValue) floatMap[apiItem.assetid] = { fv: apiItem.floatValue, ps: apiItem.paintSeed };
          }
          // Apply to DOM
          for (const item of items) {
            if (item.side !== 'your') continue;
            const aid = String(item.assetid ?? '');
            if (!aid) continue;
            const fdata = floatMap[aid];
            if (!fdata) continue;
            // Find DOM element and add float
            const el = this.findItemElement(item);
            if (el && !el.querySelector('.floatIndicator')) {
              addFloatIndicator(el as HTMLElement, fdata.fv, 4);
              enriched++;
            }
          }
          logger.info('Enriched OUR items on list', { apiItems: result.items.length, enriched });
        }
      } catch (err) {
        logger.warn('Failed to enrich our items on list', { error: String(err) });
      }
    }

    // Partner float on list page: not feasible (partnerinventory requires trade page context)
    // Partner float works on individual trade offer pages

    if (enriched > 0) {
      logger.info('Float enrichment on trade offers list complete', { enriched });
    }
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

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
