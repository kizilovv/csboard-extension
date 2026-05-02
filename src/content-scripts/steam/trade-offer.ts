// ============================================================
// CSBOARD Content Script — Steam Trade Offer Page
// ============================================================
// Injected on: steamcommunity.com/tradeoffer/*
// Works on BOTH /tradeoffer/new/ AND /tradeoffer/{id}/
//
// Architecture (following cs2trader EXACTLY):
// 1. injectScript() — synchronous page-context execution via onreset trick
// 2. getItemInfoFromPage(who) — reads UserYou/UserThem.getInventory()
// 3. buildInventoryStructure() — normalizes item data
// 4. Prices from chrome.storage.local via priceEngine
// 5. addPerItemInfo() — adds price tags to DOM elements
// 6. addFunctionBars() — Take/Remove controls
// 7. singleClickControlClick — click=move, ctrl+click=move all same
// 8. periodicallyUpdateTotals — updates in-trade totals every 1s

import { priceEngine } from '../../shared/price-engine';
import { createLogger } from '../../shared/logger';
import { injectScript } from '../../shared/inject';
import {
  getItemByIDs, getIDsFromElement,
  getAssetIDOfElement, getItemByAssetID,
  addFloatIndicator, addSSTandExtIndicators, addDopplerPhase,
  addPatternIndicator,
  resizeTradeProtectionIcon, makeItemColorful, addTradeHoldBadge,
  parseTradability, getBuffLink, getCsFloatLink,
} from '../../shared/items';
import { getPattern } from '../../shared/patternDetector';
import { getDopplerInfo } from '../../shared/dopplerPhases';

const logger = createLogger('trade-offer');

// ============================================================
// State (cs2trader pattern: module-level variables)
// ============================================================

const combinedInventories: any[] = [];
let userSteamID: string = '';
let partnerSteamID: string = '';
let offerID: string = '';

// ============================================================
// cs2trader: getSteamID / getTradePartnerSteamID / getOfferID
// ============================================================

const getUserSteamIDFromPage = (): string => {
  const script = "document.querySelector('body').setAttribute('steamidOfLoggedinUser', typeof g_steamID !== 'undefined' ? g_steamID : (typeof g_rgCurrentTradeStatus !== 'undefined' ? '' : ''));";
  return injectScript(script, true, 'getSteamID', 'steamidOfLoggedinUser') || '';
};

const getTradePartnerSteamID = (): string => {
  const script = "document.querySelector('body').setAttribute('tradePartnerSteamID', typeof g_ulTradePartnerSteamID !== 'undefined' ? g_ulTradePartnerSteamID : '');";
  return injectScript(script, true, 'tradePartnerSteamID', 'tradePartnerSteamID') || '';
};

const getOfferID = (): string => {
  try {
    const script = "document.querySelector('body').setAttribute('offerID', g_strTradePartnerInventoryLoadURL.split('tradeoffer/')[1].split('/partner')[0]);";
    return injectScript(script, true, 'getOfferID', 'offerID') || 'new';
  } catch {
    // Fallback: parse from URL
    const match = window.location.pathname.match(/\/tradeoffer\/(\d+)/);
    return (match?.[1]) ?? 'new';
  }
};

// ============================================================
// cs2trader: getActiveInventory / getActiveInventoryIDs
// ============================================================

const getActiveInventory = (): HTMLElement | null => {
  let active: HTMLElement | null = null;
  document.querySelectorAll('.inventory_ctn').forEach((inv) => {
    const el = inv as HTMLElement;
    if (el.style.display !== 'none' && el.id !== 'trade_inventory_unavailable') active = el;
  });
  return active;
};

const getActiveInventoryIDs = (): { appID: string; contextID: string } | null => {
  const activeInv = getActiveInventory();
  if (!activeInv) return null;
  const parts = activeInv.id.split('_');
  return {
    appID: parts[2] || '',
    contextID: parts[3] || '',
  };
};

// ============================================================
// cs2trader: getItemInfoFromPage(who) — EXACT PORT
// Uses injectScript to access UserYou/UserThem.getInventory()
// ============================================================

const getItemInfoFromPage = (who: 'You' | 'Them'): Record<string, { contextID: string; items: any[] }> | null => {
  // Step 1: Get app IDs from User object
  const getAppInfoScript = `
    appIDs = {};
    try {
      appIDsArray = Object.keys(User${who}.rgAppInfo);
      appIDsArray.forEach(function(appID) {
        appIDs[appID] = appID;
      });
    } catch(e) {}
    document.querySelector('body').setAttribute('userAppInfo', JSON.stringify(appIDs));
  `;
  const appInfoStr = injectScript(getAppInfoScript, true, 'getAppInfo', 'userAppInfo');
  if (!appInfoStr) return null;

  let appInfo: Record<string, string>;
  try {
    appInfo = JSON.parse(appInfoStr);
  } catch {
    return null;
  }

  // Step 2: Gather app/context IDs from active inventory + items in offer
  let sideAppAndContextIDs: Array<{ appID: string; contextID: string }> = [];
  const activeInventoryIDs = getActiveInventoryIDs();

  if (activeInventoryIDs && appInfo[activeInventoryIDs.appID] !== undefined) {
    sideAppAndContextIDs.push(activeInventoryIDs);
  }

  // Force CS2 context to '2'
  if (activeInventoryIDs && activeInventoryIDs.appID === '730') {
    activeInventoryIDs.contextID = '2';
  }

  const whose = who === 'You' ? 'your' : 'their';
  const side = document.getElementById(`trade_${whose}s`);
  if (side) {
    side.querySelectorAll('.item').forEach((itemEl) => {
      const itemIDs = getIDsFromElement(itemEl as HTMLElement, 'offer');
      if (itemIDs && itemIDs.appID !== 'anonymous' && appInfo[itemIDs.appID] !== undefined) {
        // Remove duplicate and re-add
        sideAppAndContextIDs = sideAppAndContextIDs.filter((IDs) =>
          !(IDs.appID === itemIDs.appID && IDs.contextID === itemIDs.contextID)
        );
        sideAppAndContextIDs.push({ appID: itemIDs.appID, contextID: itemIDs.contextID });
      }
    });
  }

  // Step 3: For each app/context, inject script to get inventory
  const inventoryInfos: Record<string, { contextID: string; items: any[] }> = {};

  for (const IDs of sideAppAndContextIDs) {
    // Use m_rgAssets (has properties for float) with rgInventory as fallback
    const getItemsScript = `
      try {
        inventory = User${who}.getInventory(${IDs.appID},${IDs.contextID});
        steamID = inventory.owner ? inventory.owner.strSteamId : '';
        trimmedAssets = [];
        var assetProps = {};
        try { assetProps = inventory.m_rgAssetProperties || {}; } catch(e) {}

        // Try m_rgAssets first (has properties + description object)
        var useNewFormat = inventory.m_rgAssets && Object.keys(inventory.m_rgAssets).length > 0;

        if (useNewFormat) {
          for (var key in inventory.m_rgAssets) {
            if (!inventory.m_rgAssets.hasOwnProperty(key)) continue;
            var asset = inventory.m_rgAssets[key];
            if (!asset.hasOwnProperty('appid')) continue;
            var desc = asset.description || {};
            var safeProp = null;
            try {
              var rawProp = assetProps[asset.assetid];
              if (rawProp) {
                safeProp = [];
                for (var pk in rawProp) {
                  if (!rawProp.hasOwnProperty(pk)) continue;
                  var p = rawProp[pk];
                  if (p) safeProp.push({propertyid:p.propertyid,int_value:p.int_value||null,float_value:p.float_value||null});
                }
              }
            } catch(pe) {}
            trimmedAssets.push({
              amount: asset.amount,
              appid: asset.appid.toString(),
              assetid: asset.assetid.toString(),
              classid: asset.classid,
              icon: desc.icon_url || '',
              instanceid: asset.instanceid.toString(),
              contextid: asset.contextid.toString(),
              descriptions: desc.descriptions || [],
              market_hash_name: desc.market_hash_name || '',
              marketable: desc.marketable,
              name: desc.name || '',
              name_color: desc.name_color || '',
              position: asset.pos,
              type: desc.type || '',
              owner: steamID,
              tags: desc.tags || [],
              owner_descriptions: desc.owner_descriptions || [],
              properties: safeProp
            });
          }
        } else {
          // Fallback: rgInventory (flat structure, no properties)
          var assets = inventory.rgInventory;
          if (assets !== null) {
            for (var key2 in assets) {
              if (!assets.hasOwnProperty(key2)) continue;
              var asset2 = assets[key2];
              trimmedAssets.push({
                amount: asset2.amount,
                appid: asset2.appid.toString(),
                assetid: asset2.id.toString(),
                classid: asset2.classid,
                icon: asset2.icon_url,
                instanceid: asset2.instanceid.toString(),
                contextid: asset2.contextid.toString(),
                descriptions: asset2.descriptions,
                market_hash_name: asset2.market_hash_name,
                marketable: asset2.marketable,
                name: asset2.name,
                name_color: asset2.name_color,
                position: asset2.pos,
                type: asset2.type,
                owner: steamID,
                tags: asset2.tags,
                owner_descriptions: asset2.owner_descriptions,
                properties: null
              });
            }
          } else trimmedAssets = null;
        }
        document.querySelector('body').setAttribute('offerInventoryInfo', JSON.stringify(trimmedAssets));
      } catch(e) {
        document.querySelector('body').setAttribute('offerInventoryInfo', 'null');
      }
    `;

    const itemsStr = injectScript(getItemsScript, true, 'getOfferItemInfo', 'offerInventoryInfo');
    if (!itemsStr || itemsStr === 'null') continue;

    try {
      const items = JSON.parse(itemsStr);
      if (items === null) continue;
      inventoryInfos[IDs.appID] = {
        contextID: IDs.contextID,
        items,
      };
    } catch {
      continue;
    }
  }

  return Object.keys(inventoryInfos).length !== 0 ? inventoryInfos : null;
};

// ============================================================
// cs2trader: buildInventoryStructure(inventory) — EXACT PORT
// ============================================================

const buildInventoryStructure = (inventory: any[]): any[] => {
  const inventoryArray: any[] = [];
  const duplicates: Record<string, { num: number; instances: string[] }> = {};

  inventory.forEach((item) => {
    if (duplicates[item.market_hash_name] === undefined) {
      duplicates[item.market_hash_name] = { num: 1, instances: [item.assetid] };
    } else {
      duplicates[item.market_hash_name]!.num += 1;
      duplicates[item.market_hash_name]!.instances.push(item.assetid);
    }
  });

  inventory.forEach((item) => {
    // Parse tradability
    const tradInfo = parseTradability(
      item.marketable != null ? 1 : 0,
      item.descriptions,
      item.owner_descriptions,
    );

    // cs2trader: parse float from properties (propertyid 2 = float, 1 = paintseed)
    let floatInfo: { floatvalue?: number; paintseed?: number } | null = null;
    if (item.properties) {
      const props = Array.isArray(item.properties) ? item.properties : Object.values(item.properties);
      floatInfo = {};
      for (const prop of props as any[]) {
        if (!prop) continue;
        if ((prop.propertyid === 1 || prop.def_index === 1) && (prop.int_value || prop.value))
          floatInfo.paintseed = parseInt(prop.int_value || prop.value);
        if ((prop.propertyid === 2 || prop.def_index === 2) && (prop.float_value || prop.value))
          floatInfo.floatvalue = parseFloat(prop.float_value || prop.value);
      }
      if (!floatInfo.floatvalue && !floatInfo.paintseed) floatInfo = null;
    }

    // cs2trader: sticker price from description.name === 'sticker_info'
    let stickerTotal = 0;
    if (item.descriptions) {
      for (const d of item.descriptions) {
        if (d && (d.name === 'sticker_info' || d.name === 'keychain_info')) {
          const val = d.value || '';
          const afterBr = val.split('><br>')[1];
          if (afterBr) {
            const afterColon = afterBr.split(': ')[1];
            if (afterColon) {
              const nameStr = afterColon.split('</center>')[0];
              const names = nameStr.split(', ');
              const prefix = d.name === 'sticker_info' ? 'Sticker' : 'Charm';
              for (const name of names) {
                const sp = priceEngine.getPrice(`${prefix} | ${name.trim()}`);
                if (sp) stickerTotal += sp.raw;
              }
            }
          }
        }
      }
    }

    inventoryArray.push({
      name: item.name,
      market_hash_name: item.market_hash_name,
      name_color: item.name_color,
      classid: item.classid,
      instanceid: item.instanceid,
      assetid: item.assetid,
      appid: item.appid.toString(),
      contextid: item.contextid,
      marketable: item.marketable,
      position: item.position,
      iconURL: item.icon,
      quality: null,
      type: { key: item.type || 'other' },
      isStatrack: (item.name || '').includes('StatTrak'),
      isSouvenir: (item.name || '').includes('Souvenir'),
      duplicates: duplicates[item.market_hash_name],
      owner: item.owner,
      floatInfo,
      patternInfo: getPattern(item.market_hash_name, floatInfo?.paintseed ?? null),
      descriptions: item.descriptions,
      tags: item.tags,
      tradabilityShort: tradInfo.tradabilityShort,
      stickerTotal,
      price: undefined as { price: number; display: string } | undefined,
    });
  });

  return inventoryArray.sort((a, b) => (a.position || 0) - (b.position || 0));
};

// ============================================================
// Enrich items with prices from priceEngine (replaces cs2trader's addPricesAndFloatsToInventory)
// ============================================================

const addPricesToInventory = (items: any[]): { items: any[]; total: number; buffBidTotal: number } => {
  let total = 0;
  let buffBidTotal = 0;
  for (const item of items) {
    if (item.market_hash_name) {
      // Detect doppler phase for phase-specific pricing
      const dopplerInfo = item.iconURL ? getDopplerInfo(item.iconURL) : null;
      const dopplerPhase = dopplerInfo?.name;
      if (dopplerPhase) item.dopplerPhase = dopplerPhase;

      const priceData = priceEngine.getPrice(item.market_hash_name, dopplerPhase);
      const buffPrices = priceEngine.getBuffPrices(item.market_hash_name, dopplerPhase);
      if (priceData) {
        item.price = {
          price: priceData.raw,
          display: priceData.display,
        };
        total += priceData.raw;
      }
      // Buff bid = buy order price (what you can actually sell for instantly)
      if (buffPrices.buyOrder) {
        item.buffBid = {
          price: buffPrices.buyOrder.raw,
          display: buffPrices.buyOrder.display,
        };
        buffBidTotal += buffPrices.buyOrder.raw;
      } else if (priceData) {
        // Fallback: use main price if no buff bid
        item.buffBid = item.price;
        buffBidTotal += priceData.raw;
      }
    }
  }
  return { items, total, buffBidTotal };
};

// ============================================================
// Bulk description cache — for hold/untradable items
// ============================================================
// Steam stores item descriptions in m_rgDescriptions on inventory objects.
// For hold items, rgInventory may be empty but m_rgDescriptions still has data.
// We fetch ALL descriptions once and cache classid → market_hash_name.

let descriptionCache: Record<string, string> = {};

const fetchAllDescriptions = (): void => {
  const script = `
    try {
      var cache = {};
      function addDescs(descs) {
        if (!descs) return;
        for (var key in descs) {
          if (!descs.hasOwnProperty(key)) continue;
          var d = descs[key];
          if (d && d.market_hash_name && d.classid) {
            cache[d.classid + '_' + (d.instanceid || '0')] = d.market_hash_name;
          }
        }
      }
      // UserYou + UserThem
      ['UserYou', 'UserThem'].forEach(function(u) {
        try {
          var user = eval(u);
          if (!user || !user.rgAppInfo || !user.rgAppInfo['730']) return;
          var inv = user.getInventory(730, 2);
          if (!inv) return;
          addDescs(inv.m_rgDescriptions);
          addDescs(inv.rgDescriptions);
          // Also scan m_rgAssets for descriptions
          if (inv.m_rgAssets) {
            for (var aid in inv.m_rgAssets) {
              var a = inv.m_rgAssets[aid];
              if (a && a.description && a.description.market_hash_name && a.classid) {
                cache[a.classid + '_' + (a.instanceid || '0')] = a.description.market_hash_name;
              }
            }
          }
        } catch(e) {}
      });
      // g_rgAppContextData
      if (typeof g_rgAppContextData !== 'undefined' && g_rgAppContextData['730']) {
        var ctxs = g_rgAppContextData['730'].rgContexts;
        for (var ctx in ctxs) {
          var inv = ctxs[ctx].inventory;
          if (inv) {
            addDescs(inv.m_rgDescriptions);
            addDescs(inv.rgDescriptions);
          }
        }
      }
      document.querySelector('body').setAttribute('csboard_desc_cache', JSON.stringify(cache));
    } catch(e) {
      document.querySelector('body').setAttribute('csboard_desc_cache', '{}');
    }
  `;
  const result = injectScript(script, true, 'csboard_desc_cache_fetch', 'csboard_desc_cache');
  if (result) {
    try {
      descriptionCache = JSON.parse(result);
      logger.info('Description cache loaded', { entries: Object.keys(descriptionCache).length });
    } catch { /* ignore */ }
  }
};

// ============================================================
// cs2trader: addPerItemInfo(inventoryOwnerID) — adds price tags to DOM
// ============================================================

// Build classid_instanceid lookup for fallback matching
let combinedLookup: Record<string, any> = {};

const rebuildCombinedLookup = (): void => {
  combinedLookup = {};
  for (const item of combinedInventories) {
    if (item.classid) {
      const key = `${item.classid}_${item.instanceid || '0'}`;
      if (!combinedLookup[key]) combinedLookup[key] = item;
    }
  }
};

const addPerItemInfo = (_inventoryOwnerID?: string): void => {
  // Get ALL CS2 item elements on the page (inventory + trade slots)
  // On trade offer pages, item elements have IDs like "item730_2_ASSETID"
  // They also have data-economy-item="classinfo/730/CLASSID/INSTANCEID"
  const allItemElements = document.querySelectorAll('.item.app730.context2');

  if (allItemElements.length === 0) return;

  let processed = 0;

  allItemElements.forEach((itemElement) => {
    const el = itemElement as HTMLElement;
    if (el.getAttribute('data-processed') === 'true') return;

    // Hide CSFloat elements via CSS instead of removing (removing can break Steam DOM)
    [...el.children].forEach(child => {
      if (child.tagName && child.tagName.toLowerCase().startsWith('csfloat')) {
        (child as HTMLElement).style.display = 'none';
      }
    });

    let item: any = null;

    // Method 1: match by element ID (item730_2_ASSETID)
    if (el.id && el.id.includes('_')) {
      const assetID = getAssetIDOfElement(el);
      if (assetID) {
        item = getItemByAssetID(combinedInventories, assetID);
      }
    }

    // Method 2: match by data-economy-item (classinfo/730/CLASSID/INSTANCEID)
    if (!item) {
      const dataAttr = el.getAttribute('data-economy-item');
      if (dataAttr) {
        const parts = dataAttr.split('/');
        const classid = parts[2] || '';
        const instanceid = parts[3] || '0';
        if (classid) {
          item = combinedLookup[`${classid}_${instanceid}`];
        }
      }
    }

    // Method 3: direct price lookup by market_hash_name attribute
    if (!item) {
      const nameAttr = el.getAttribute('data-market-hash-name');
      if (nameAttr) {
        const priceData = priceEngine.getPrice(nameAttr);
        const buffPrices = priceEngine.getBuffPrices(nameAttr);
        if (priceData) {
          item = { price: { price: priceData.raw, display: priceData.display }, market_hash_name: nameAttr };
          if (buffPrices.buyOrder) {
            item.buffBid = { price: buffPrices.buyOrder.raw, display: buffPrices.buyOrder.display };
          }
        }
      }
    }

    // Method 4: for hold/untradable items — lookup from bulk description cache
    if (!item) {
      const dataAttr = el.getAttribute('data-economy-item');
      if (dataAttr) {
        const parts = dataAttr.split('/');
        const classid = parts[2] || '';
        const instanceid = parts[3] || '0';
        if (classid) {
          const itemName = descriptionCache[`${classid}_${instanceid}`] || descriptionCache[`${classid}_0`];
          if (itemName) {
            const priceData = priceEngine.getPrice(itemName);
            const buffPrices = priceEngine.getBuffPrices(itemName);
            if (priceData) {
              item = { price: { price: priceData.raw, display: priceData.display }, market_hash_name: itemName };
              if (buffPrices.buyOrder) {
                item.buffBid = { price: buffPrices.buyOrder.raw, display: buffPrices.buyOrder.display };
              }
            }
          }
        }
      }
    }

    if (!item) return;

    // Ensure buffBid is always set (partner items from rgInventory may lack it)
    if (!item.buffBid && item.market_hash_name) {
      const buffPrices = priceEngine.getBuffPrices(item.market_hash_name);
      if (buffPrices.buyOrder) {
        item.buffBid = { price: buffPrices.buyOrder.raw, display: buffPrices.buyOrder.display };
      } else if (item.price) {
        item.buffBid = item.price;
      }
    }

    // Price indicator — no background, white text (cs2trader native look)
    if (!el.querySelector('.priceIndicator')) {
      const mainPrice = item.price?.display || '';
      const buffBid = item.buffBid?.price ?? 0;
      const mainVal = item.price?.price ?? 0;
      const isBoosted = mainVal > 0.1 && buffBid > 0 && buffBid < mainVal * 0.8;

      if (mainPrice) {
        const cls = isBoosted ? 'priceIndicator boostedPrice' : 'priceIndicator';
        el.insertAdjacentHTML('beforeend', `<div class="${cls}">${mainPrice}</div>`);
      }

      // Buff bid — always show if available and different from main price
      const showBuffBid = item.buffBid && item.price && mainVal > 0.1
        && buffBid > 0 && Math.abs(mainVal - buffBid) > 0.01;
      if (showBuffBid) {
        el.insertAdjacentHTML('beforeend', `<div class="buffBidIndicator">${item.buffBid.display}</div>`);
      }
    }

    // Images loaded via loadAllItemsProperly() — forces Steam's own LoadPageImages

    // cs2trader: makeItemColorful — colored backgrounds by rarity, doppler gets phase color
    makeItemColorful(el, item.tags, item.name_color, item.market_hash_name || item.name, item.iconURL);

    // Float indicator (above price)
    if (item.floatInfo?.floatvalue) {
      addFloatIndicator(el, item.floatInfo.floatvalue, 5);
    }

    // Exterior + StatTrak/Souvenir + sticker price (top-right)
    addSSTandExtIndicators(el, {
      isStatrack: item.isStatrack,
      isSouvenir: item.isSouvenir,
      tags: item.tags,
      stickerTotal: item.stickerTotal,
    });

    // Doppler phase badge
    addDopplerPhase(el, item.iconURL);

    // Pattern indicator (fade %, marble fade, case hardened blue %)
    addPatternIndicator(el, item.patternInfo);

    // Trade hold badge ("7d")
    if (item.tradabilityShort) {
      addTradeHoldBadge(el, item.tradabilityShort);
    }

    // Resize trade protection icon
    resizeTradeProtectionIcon(el);

    // Store market_hash_name and buff bid on element for totals
    if (item.market_hash_name) {
      el.setAttribute('data-market-hash-name', item.market_hash_name);
    }
    if (item.buffBid) {
      el.setAttribute('data-buff-bid', String(item.buffBid.price));
    }

    el.setAttribute('data-processed', 'true');
    processed++;
  });

  if (processed > 0) {
    logger.debug('Processed trade offer items', { processed, total: allItemElements.length });
  }
};

// ============================================================
// cs2trader: addInventoryTotals — totals on inventory tab headers
// ============================================================

const addInventoryTotals = (yourTotal: number, theirTotal: number, _yourBuffBid?: number, _theirBuffBid?: number): void => {
  const settings = priceEngine.getSettings();
  const sign = settings.currency === 'USD' ? '$' : settings.currency + ' ';
  const prettyPrice = (v: number) => `${sign}${v.toFixed(0)}`;

  // cs2trader exact: append price to innerText of the tab div
  const yourTab = document.getElementById('inventory_select_your_inventory')?.querySelector('div');
  if (yourTab && !yourTab.innerText.includes(sign)) {
    const text = `${yourTab.innerText} (${prettyPrice(yourTotal)})`;
    yourTab.innerText = text.length < 30 ? text : text.substring(0, 30);
    // Adjust font size for long prices
    (yourTab as HTMLElement).style.fontSize = prettyPrice(yourTotal).length <= 7 ? '16px' : '13px';
  }

  const theirTab = document.getElementById('inventory_select_their_inventory')?.querySelector('div');
  if (theirTab && !theirTab.innerText.includes(sign)) {
    const text = `${theirTab.innerText} (${prettyPrice(theirTotal)})`;
    theirTab.innerText = text.length < 30 ? text : text.substring(0, 30);
    (theirTab as HTMLElement).style.fontSize = prettyPrice(theirTotal).length <= 7 ? '16px' : '13px';
  }

  logger.info('Inventory totals set', { your: yourTotal.toFixed(2), their: theirTotal.toFixed(2) });
};

// ============================================================
// cs2trader: addInTradeTotals(whose) — totals on "Items:" headers
// ============================================================

const addInTradeTotals = (whose: string): void => {
  const settings = priceEngine.getSettings();
  const sign = settings.currency === 'USD' ? '$' : settings.currency + ' ';

  const itemsInTrade = document.getElementById(`${whose}_slots`)?.querySelectorAll('.item');
  if (!itemsInTrade) return;

  let inTradeTotal = 0;
  let inTradeBuffBid = 0;

  itemsInTrade.forEach((inTradeItem) => {
    const IDs = getIDsFromElement(inTradeItem as HTMLElement, 'offer');
    if (!IDs) return;
    const item = getItemByIDs(combinedInventories, IDs.appID, IDs.contextID, IDs.assetID);
    if (item && item.price) {
      inTradeTotal += item.price.price;
    }
    if (item && item.buffBid) {
      inTradeBuffBid += item.buffBid.price;
    }
  });

  // Update header — cs2trader style
  const totalEl = document.getElementById(`${whose}InTradeTotal`);
  if (!totalEl) {
    let itemsTextDiv: HTMLElement | null;
    if (whose === 'your') {
      itemsTextDiv = document.querySelector('#trade_yours h2.ellipsis');
    } else {
      itemsTextDiv = document.querySelector('#trade_theirs .offerheader h2');
    }
    if (itemsTextDiv) {
      const text = itemsTextDiv.innerText ?? '';
      const baseText = (text.split('(')[0]?.split(':')[0] ?? text).trim();
      itemsTextDiv.innerHTML = `${baseText} (<span id="${whose}InTradeTotal" class="csboard-trade-total" data-total="${inTradeTotal}" data-buff-bid="${inTradeBuffBid}">${sign}${inTradeTotal.toFixed(2)}</span>):`;
    }
  } else {
    totalEl.textContent = `${sign}${inTradeTotal.toFixed(2)}`;
    totalEl.setAttribute('data-total', String(inTradeTotal));
    totalEl.setAttribute('data-buff-bid', String(inTradeBuffBid));
  }
};

// ============================================================
// cs2trader: addPLInfo — Profit/Loss display
// ============================================================

const addPLInfo = (): void => {
  const yourTotalEl = document.getElementById('yourInTradeTotal');
  const theirTotalEl = document.getElementById('theirInTradeTotal');

  if (!yourTotalEl || !theirTotalEl) return;

  const settings = priceEngine.getSettings();
  const sign = settings.currency === 'USD' ? '$' : settings.currency + ' ';

  // Main source totals
  const yourTotal = parseFloat(yourTotalEl.getAttribute('data-total') || '0');
  const theirTotal = parseFloat(theirTotalEl.getAttribute('data-total') || '0');
  const pl = theirTotal - yourTotal;
  const plPct = yourTotal > 0 ? ((pl / yourTotal) * 100) : 0;

  // Buff bid totals
  const yourBuffBid = parseFloat(yourTotalEl.getAttribute('data-buff-bid') || '0');
  const theirBuffBid = parseFloat(theirTotalEl.getAttribute('data-buff-bid') || '0');
  const buffPl = theirBuffBid - yourBuffBid;
  const buffPct = yourBuffBid > 0 ? ((buffPl / yourBuffBid) * 100) : 0;

  // cs2trader style: "Show trade summary" link with P/L inline
  const plClass = pl > 0 ? 'profit' : 'loss';
  const buffPlClass = buffPl > 0 ? 'profit' : 'loss';
  const plSignStr = pl > 0 ? '+' : '';
  const buffPlSignStr = buffPl > 0 ? '+' : '';
  const pctStr = (plPct > 0 ? '+' : '') + plPct.toFixed(1) + '%';
  const buffPctStr = (buffPct > 0 ? '+' : '') + buffPct.toFixed(1) + '%';

  // Insert/update summary — like cs2trader's #offerSummary
  let summaryEl = document.getElementById('csboard-offer-summary');
  const filterMenu = document.getElementById('nonresponsivetrade_itemfilters');

  if (!summaryEl && filterMenu) {
    summaryEl = document.createElement('div');
    summaryEl.id = 'csboard-offer-summary';
    filterMenu.insertAdjacentElement('beforebegin', summaryEl);
  }

  if (summaryEl && (yourTotal > 0 || theirTotal > 0)) {
    summaryEl.innerHTML = `
      <span class="clickable bold">Trade Summary</span>
      (<span class="${plClass}">${plSignStr}${sign}${pl.toFixed(2)}  ${pctStr}</span>)
      <span class="csboard-buff-summary">Buff: <span class="${buffPlClass}">${buffPlSignStr}${sign}${buffPl.toFixed(2)}  ${buffPctStr}</span></span>
    `;
  }
};

// ============================================================
// cs2trader: periodicallyUpdateTotals
// ============================================================

const periodicallyUpdateTotals = (): void => {
  setInterval(() => {
    if (!document.hidden) {
      addInTradeTotals('your');
      addInTradeTotals('their');
      addPLInfo();
    }
  }, 1000);
};

// ============================================================
// cs2trader: moveItem / removeLeftOverSlots
// ============================================================

const moveItem = (item: Element): void => {
  const clickEvent = document.createEvent('MouseEvents');
  clickEvent.initEvent('dblclick', true, true);
  item.dispatchEvent(clickEvent);
};

const removeLeftOverSlots = (): void => {
  setTimeout(() => {
    document.querySelectorAll('.itemHolder.trade_slot').forEach((slot) => {
      const parent = slot.parentNode as HTMLElement;
      if (parent && parent.id !== 'your_slots' && parent.id !== 'their_slots') slot.remove();
    });
  }, 500);
};

// ============================================================
// cs2trader: singleClickControlClickHandler — EXACT PORT
// ============================================================

const singleClickControlClickHandler = (event: MouseEvent): void => {
  // cs2trader dispatches on event.target (the image inside the item), NOT event.currentTarget
  if (event.ctrlKey) {
    // Ctrl+Click: move ALL items with same market_hash_name
    const parentEl = (event.target as HTMLElement).parentNode as HTMLElement;
    const itemData = getItemByAssetID(combinedInventories, getAssetIDOfElement(parentEl));
    if (!itemData) {
      moveItem(event.target as Element);
      return;
    }
    const marketHashNameToLookFor = itemData.market_hash_name;

    let inInventory: Element | null;
    const grandparent4 = parentEl?.parentNode?.parentNode?.parentNode?.parentNode as HTMLElement;
    if (grandparent4?.id === 'their_slots') inInventory = document.getElementById('their_slots');
    else if (grandparent4?.id === 'your_slots') inInventory = document.getElementById('your_slots');
    else inInventory = getActiveInventory();

    if (inInventory) {
      inInventory.querySelectorAll('.item.app730.context2').forEach((item) => {
        const itemAssetID = getAssetIDOfElement(item as HTMLElement);
        const itemObj = getItemByAssetID(combinedInventories, itemAssetID);
        if (itemObj && itemObj.market_hash_name === marketHashNameToLookFor) {
          moveItem(item);
        }
      });
    }
    removeLeftOverSlots();
  } else {
    // Single click = move the item (dispatch dblclick on event.target, same as cs2trader)
    moveItem(event.target as Element);
  }
};

const rightClickControlHandler = (event: MouseEvent): void | boolean => {
  if (event.ctrlKey) {
    event.preventDefault();
    (event.target as HTMLElement).parentNode?.parentElement?.classList.toggle('cstSelected');
    return false;
  }
};

// ============================================================
// cs2trader: singleClickControlClick — attaches handlers
// Uses event delegation on trade area + direct attach for robustness
// ============================================================

let delegationSetup = false;

const singleClickControlClick = (): void => {
  // Direct attach to all current items
  document.querySelectorAll('.item.app730.context2').forEach((item) => {
    item.removeEventListener('click', singleClickControlClickHandler as EventListener);
    item.removeEventListener('contextmenu', rightClickControlHandler as EventListener, false);
    item.addEventListener('click', singleClickControlClickHandler as EventListener);
    item.addEventListener('contextmenu', rightClickControlHandler as EventListener, false);
  });

  // Event delegation on inventory containers (catches dynamically loaded items)
  if (!delegationSetup) {
    delegationSetup = true;
    const tradeArea = document.getElementById('mainContent') || document.body;
    tradeArea.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const itemEl = target.closest('.item.app730.context2');
      if (!itemEl) return;
      // Only handle if not already handled by direct listener
      if (!(itemEl as any)._csboardClick) {
        singleClickControlClickHandler(e);
      }
    });

    // MutationObserver: when new items appear in inventory, attach handlers
    const inventoryArea = document.getElementById('inventories');
    if (inventoryArea) {
      const observer = new MutationObserver(() => {
        document.querySelectorAll('.item.app730.context2').forEach((item) => {
          if (!(item as any)._csboardClick) {
            (item as any)._csboardClick = true;
            item.addEventListener('click', singleClickControlClickHandler as EventListener);
            item.addEventListener('contextmenu', rightClickControlHandler as EventListener, false);
          }
        });
      });
      observer.observe(inventoryArea, { childList: true, subtree: true });
    }
  }

  // Mark all current items
  document.querySelectorAll('.item.app730.context2').forEach((item) => {
    (item as any)._csboardClick = true;
  });
};

// ============================================================
// cs2trader: Sorting modes (from sortingModes.js)
// ============================================================

const sortingModes: Record<string, { key: string; name: string }> = {
  default: { key: 'default', name: 'Default (position last to first)' },
  reverse: { key: 'reverse', name: 'Reverse (position first to last)' },
  price_desc: { key: 'price_desc', name: 'Price (expensive to cheap)' },
  price_asc: { key: 'price_asc', name: 'Price (cheap to expensive)' },
  name_asc: { key: 'name_asc', name: 'Alphabetical (a to z)' },
  name_desc: { key: 'name_desc', name: 'Alphabetical (z to a)' },
};

// ============================================================
// cs2trader: loadAllItemsProperly — forces Steam to load images for ALL pages
// ============================================================

const loadAllItemsProperly = (): void => {
  injectScript(`
    try {
      g_ActiveInventory.pageList.forEach(function (page, index) {
        g_ActiveInventory.pageList[index].images_loaded = false;
        g_ActiveInventory.LoadPageImages(page);
      });
    } catch(e) {}
  `, false);
};

// ============================================================
// cs2trader: doTheSorting — EXACT PORT (sorting.js)
// ============================================================

const doTheSorting = (items: any[], itemElements: HTMLElement[], method: string, pages: NodeListOf<Element> | HTMLElement | null, type: string): HTMLElement[] | void => {
  const getItem = (el: HTMLElement) => {
    const assetID = getAssetIDOfElement(el);
    if (assetID) return getItemByAssetID(items, assetID);
    // Fallback: classid_instanceid lookup
    const dataAttr = el.getAttribute('data-economy-item');
    if (dataAttr) {
      const parts = dataAttr.split('/');
      const key = `${parts[2] || ''}_${parts[3] || '0'}`;
      return combinedLookup[key] || null;
    }
    return null;
  };

  let sortedElements: HTMLElement[];

  if (method === 'price_asc') {
    sortedElements = itemElements.sort((a, b) => {
      const pa = getItem(a)?.price?.price ?? 0;
      const pb = getItem(b)?.price?.price ?? 0;
      return pa - pb;
    });
  } else if (method === 'price_desc') {
    sortedElements = itemElements.sort((a, b) => {
      const pa = getItem(a)?.price?.price ?? 0;
      const pb = getItem(b)?.price?.price ?? 0;
      return pb - pa;
    });
  } else if (method === 'name_asc') {
    sortedElements = itemElements.sort((a, b) => {
      const na = (getItem(a)?.market_hash_name || '').toLowerCase();
      const nb = (getItem(b)?.market_hash_name || '').toLowerCase();
      return na < nb ? -1 : na > nb ? 1 : 0;
    });
  } else if (method === 'name_desc') {
    sortedElements = itemElements.sort((a, b) => {
      const na = (getItem(a)?.market_hash_name || '').toLowerCase();
      const nb = (getItem(b)?.market_hash_name || '').toLowerCase();
      return na > nb ? -1 : na < nb ? 1 : 0;
    });
  } else if (method === 'default') {
    sortedElements = itemElements.sort((a, b) => {
      const ia = getItem(a);
      const ib = getItem(b);
      return (ia?.position || 0) - (ib?.position || 0);
    });
  } else if (method === 'reverse') {
    sortedElements = itemElements.sort((a, b) => {
      const ia = getItem(a);
      const ib = getItem(b);
      return (ib?.position || 0) - (ia?.position || 0);
    });
  } else {
    sortedElements = itemElements;
  }

  if (type === 'offer') {
    sortedElements.reverse();
    const pagesEl = pages as NodeListOf<Element>;
    const numberOfItemsPerPage = 16;
    pagesEl.forEach((page) => {
      const emptySlots: Element[] = [];
      page.querySelectorAll('.itemHolder').forEach((ih) => {
        if (ih.children.length === 1) emptySlots.push(ih);
      });
      page.innerHTML = '';
      for (let i = 0; i < numberOfItemsPerPage; i++) {
        const emptySlot = emptySlots[i];
        if (emptySlot) {
          page.appendChild(emptySlot);
        } else {
          const item = sortedElements.pop();
          if (item && item.parentElement) page.appendChild(item.parentElement);
          else {
            const newEmptySlot = document.createElement('div');
            newEmptySlot.classList.add('itemHolder', 'disabled');
            page.appendChild(newEmptySlot);
          }
        }
      }
    });
  } else if (type === 'your' || type === 'their') {
    sortedElements.reverse();
    const slotsEl = pages as HTMLElement;
    sortedElements.forEach((itemElement) => {
      slotsEl?.insertAdjacentElement('afterbegin', itemElement.parentNode!.parentNode as Element);
    });
  } else {
    return sortedElements;
  }

};

// ============================================================
// cs2trader: sortItems — EXACT PORT
// ============================================================

const sortItems = (method: string, type: string): void => {
  const activeInventoryIDs = getActiveInventoryIDs();
  if (!activeInventoryIDs || activeInventoryIDs.appID !== '730') return;

  if (type === 'offer') {
    const activeInventory = getActiveInventory();
    if (!activeInventory) return;
    // Get items from ALL contexts (not just context2)
    const items = activeInventory.querySelectorAll('.item.app730');
    const offerPages = activeInventory.querySelectorAll('.inventory_page');
    doTheSorting(combinedInventories, Array.from(items) as HTMLElement[], method, offerPages, type);
  } else {
    const items = document.getElementById(`trade_${type}s`)?.querySelectorAll('.item.app730');
    if (!items) return;
    doTheSorting(combinedInventories, Array.from(items) as HTMLElement[], method, document.getElementById(`${type}_slots`), type);
  }

  loadAllItemsProperly();
};

// ============================================================
// cs2trader: addAPartysFunctionBar(whose) — EXACT PORT
// ============================================================

const addAPartysFunctionBar = (whose: string): void => {
  const tradeEl = document.getElementById(`trade_${whose}s`);
  if (!tradeEl) return;
  const header = tradeEl.querySelector('.offerheader');
  if (!header) return;
  if (document.getElementById(`offer_${whose}_function_bar`)) return;

  header.insertAdjacentHTML('afterend', `
    <div id="offer_${whose}_function_bar">
      <div id="offer_${whose}_sorting" class="functionBarRow">
        <span>Sorting:</span>
        <select id="offer_${whose}_sorting_mode"></select>
        <button class="csboard-save-sort" id="save_sort_${whose}" title="Save as default">Save</button>
      </div>
      <div id="offer_${whose}_remove" class="functionBarRow">
        <span>Remove: </span>
        <span class="offer_action clickable" id="remove_${whose}_everything_button">Everything</span>
      </div>
    </div>
  `);

  // Remove everything
  document.getElementById(`remove_${whose}_everything_button`)?.addEventListener('click', () => {
    tradeEl.querySelectorAll('.item').forEach((item) => { moveItem(item); });
    removeLeftOverSlots();
  });

};

// ============================================================
// cs2trader: addFunctionBars — EXACT PORT
// ============================================================

const addFunctionBars = (): void => {
  const filterBar = document.getElementById('responsivetrade_itemfilters');
  if (!filterBar) {
    setTimeout(addFunctionBars, 500);
    return;
  }
  if (document.getElementById('offer_function_bar')) return;

  filterBar.insertAdjacentHTML('beforebegin', `
    <div id="offer_function_bar">
      <div id="offer_sorting" class="functionBarRow">
        <span>Sorting:</span>
        <select id="offer_sorting_mode"></select>
        <button class="csboard-save-sort" id="save_sort_offer" title="Save as default">Save</button>
      </div>
      <div id="offer_take" class="functionBarRow">
        <span>Take: </span>
        <span class="offer_action clickable" id="take_all_button">All page</span>
        <span class="offer_action clickable" id="take_everything_button">Everything</span>
      </div>
    </div>
  `);

  // Take all from page
  document.getElementById('take_all_button')?.addEventListener('click', () => {
    const activeInv = getActiveInventory();
    if (!activeInv) return;
    let activePage: HTMLElement | null = null;
    activeInv.querySelectorAll('.inventory_page').forEach((page) => {
      if ((page as HTMLElement).style.display !== 'none') activePage = page as HTMLElement;
    });
    if (activePage) {
      (activePage as HTMLElement).querySelectorAll('.item').forEach((item) => { moveItem(item); });
    }
  });

  // Take everything
  document.getElementById('take_everything_button')?.addEventListener('click', () => {
    const activeInv = getActiveInventory();
    if (!activeInv) return;
    activeInv.querySelectorAll('.item').forEach((item) => { moveItem(item); });
  });

  addAPartysFunctionBar('your');
  addAPartysFunctionBar('their');

  // Populate sorting dropdowns
  const sortingSelect = document.getElementById('offer_sorting_mode') as HTMLSelectElement;
  const yourSortingSelect = document.getElementById('offer_your_sorting_mode') as HTMLSelectElement;
  const theirSortingSelect = document.getElementById('offer_their_sorting_mode') as HTMLSelectElement;

  for (const key of Object.keys(sortingModes)) {
    const sortMode = sortingModes[key];
    if (!sortMode) continue;
    const option = document.createElement('option');
    option.value = sortMode.key;
    option.text = sortMode.name;
    sortingSelect?.appendChild(option);
    yourSortingSelect?.appendChild(option.cloneNode(true) as HTMLOptionElement);
    theirSortingSelect?.appendChild(option.cloneNode(true) as HTMLOptionElement);
  }

  // Load saved defaults
  chrome.storage.local.get(['csboard_default_sort_offer', 'csboard_default_sort_your', 'csboard_default_sort_their'], (saved) => {
    if (saved.csboard_default_sort_offer && sortingSelect) {
      sortingSelect.value = saved.csboard_default_sort_offer;
    }
    if (saved.csboard_default_sort_your && yourSortingSelect) {
      yourSortingSelect.value = saved.csboard_default_sort_your;
    }
    if (saved.csboard_default_sort_their && theirSortingSelect) {
      theirSortingSelect.value = saved.csboard_default_sort_their;
    }
  });

  // Sort on change (no auto-save — explicit Save button)
  sortingSelect?.addEventListener('change', () => {
    const value = sortingSelect?.value;
    if (value) { sortItems(value, 'offer'); addPerItemInfo(userSteamID); addPerItemInfo(partnerSteamID); }
  });
  yourSortingSelect?.addEventListener('change', () => {
    const value = yourSortingSelect?.value;
    if (value) sortItems(value, 'your');
  });
  theirSortingSelect?.addEventListener('change', () => {
    const value = theirSortingSelect?.value;
    if (value) sortItems(value, 'their');
  });

  // Save buttons — explicit save with visual feedback
  const addSaveHandler = (btnId: string, storageKey: string, select: HTMLSelectElement | null) => {
    const btn = document.getElementById(btnId);
    btn?.addEventListener('click', () => {
      if (select) {
        chrome.storage.local.set({ [storageKey]: select.value });
        btn.textContent = 'Saved!';
        btn.classList.add('saved');
        setTimeout(() => { btn.textContent = 'Save'; btn.classList.remove('saved'); }, 2000);
      }
    });
  };
  addSaveHandler('save_sort_offer', 'csboard_default_sort_offer', sortingSelect);
  addSaveHandler('save_sort_your', 'csboard_default_sort_your', yourSortingSelect);
  addSaveHandler('save_sort_their', 'csboard_default_sort_their', theirSortingSelect);
};

// ============================================================
// cs2trader: getInventories(initial) — MAIN FLOW — EXACT PORT
// ============================================================

let getInventoriesAttempts = 0;

const getInventories = (initial: boolean): void => {
  getInventoriesAttempts++;

  const yourInventory = getItemInfoFromPage('You');
  const theirInventory = getItemInfoFromPage('Them');

  // Log only on 1st attempt and every 10th to avoid spam
  if (getInventoriesAttempts <= 2 || getInventoriesAttempts % 10 === 0) {
    logger.info(`getInventories #${getInventoriesAttempts}`, {
      yours: yourInventory !== null ? 'OK' : null,
      theirs: theirInventory !== null ? 'OK' : null,
    });
  }

  if (yourInventory !== null && theirInventory !== null) {
    // Build inventory structures (CS2 = appID 730)
    const yourCSGOItems = yourInventory['730']
      ? buildInventoryStructure(yourInventory['730'].items)
      : [];
    const theirCSGOItems = theirInventory['730']
      ? buildInventoryStructure(theirInventory['730'].items)
      : [];

    // Add prices
    const yourResult = addPricesToInventory(yourCSGOItems);
    const theirResult = addPricesToInventory(theirCSGOItems);

    // Push to combinedInventories
    yourResult.items.forEach((item) => combinedInventories.push(item));
    theirResult.items.forEach((item) => combinedInventories.push(item));
    rebuildCombinedLookup();

    // Fetch ALL descriptions from page context (for hold/untradable items)
    fetchAllDescriptions();

    logger.info('Inventories loaded', {
      yours: yourCSGOItems.length,
      theirs: theirCSGOItems.length,
      combined: combinedInventories.length,
      yourTotal: yourResult.total.toFixed(2),
      theirTotal: theirResult.total.toFixed(2),
    });

    // Force Steam to load ALL item images (including non-visible pages)
    loadAllItemsProperly();

    // Add per-item info (price tags on DOM elements)
    addPerItemInfo(userSteamID);
    addPerItemInfo(partnerSteamID);

    // Single click handlers
    singleClickControlClick();

    if (initial) {
      addInventoryTotals(yourResult.total, theirResult.total, yourResult.buffBidTotal, theirResult.buffBidTotal);
      addInTradeTotals('your');
      addInTradeTotals('their');
      addPLInfo();
      periodicallyUpdateTotals();

      // Auto-apply saved sorting defaults — DELAYED to let Steam create all pages
      setTimeout(() => {
        chrome.storage.local.get(['csboard_default_sort_offer', 'csboard_default_sort_your', 'csboard_default_sort_their'], (saved) => {
          // Force Steam to load images for all pages
          loadAllItemsProperly();

          if (saved.csboard_default_sort_offer) {
            sortItems(saved.csboard_default_sort_offer, 'offer');
            const sel = document.getElementById('offer_sorting_mode') as HTMLSelectElement;
            if (sel) sel.value = saved.csboard_default_sort_offer;
          }
          if (saved.csboard_default_sort_your) {
            sortItems(saved.csboard_default_sort_your, 'your');
            const sel = document.getElementById('offer_your_sorting_mode') as HTMLSelectElement;
            if (sel) sel.value = saved.csboard_default_sort_your;
          }
          if (saved.csboard_default_sort_their) {
            sortItems(saved.csboard_default_sort_their, 'their');
            const sel = document.getElementById('offer_their_sorting_mode') as HTMLSelectElement;
            if (sel) sel.value = saved.csboard_default_sort_their;
          }
          // Re-process items after sorting
          addPerItemInfo(userSteamID);
          addPerItemInfo(partnerSteamID);
        });
      }, 2000); // 2s delay — Steam needs time to create inventory pages
    }
  } else if (document.getElementById('error_msg') === null && getInventoriesAttempts < 60) {
    // Inventories not ready yet, retry (max 30 seconds)
    setTimeout(() => {
      getInventories(initial);
    }, 500);
  } else {
    logger.warn('Gave up loading inventories', { attempts: getInventoriesAttempts });
  }
};

// ============================================================
// Context Menu (BUFF, CSFloat, Pricempire)
// ============================================================

const setupContextMenu = (): void => {
  document.addEventListener('contextmenu', (e: MouseEvent) => {
    if (e.ctrlKey) return; // Ctrl+Right is for selection

    const target = e.target as HTMLElement;
    const itemEl = target.closest('[data-market-hash-name]') || target.closest('.item.app730.context2');
    if (!itemEl) return;

    let name = itemEl.getAttribute('data-market-hash-name');
    if (!name) {
      const assetID = getAssetIDOfElement(itemEl as HTMLElement);
      const item = getItemByAssetID(combinedInventories, assetID);
      if (item) name = item.market_hash_name;
    }
    if (!name) return;

    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, name);
  });

  document.addEventListener('click', () => {
    document.getElementById('csboard-context-menu')?.remove();
  });
};

const showContextMenu = (x: number, y: number, marketName: string): void => {
  document.getElementById('csboard-context-menu')?.remove();

  const encodedName = encodeURIComponent(marketName);
  const price = priceEngine.getPrice(marketName);
  const settings = priceEngine.getSettings();
  const sign = settings.currency === 'USD' ? '$' : settings.currency;

  const sanitize = (text: string): string => {
    const el = document.createElement('span');
    el.textContent = text;
    return el.innerHTML;
  };

  const menu = document.createElement('div');
  menu.id = 'csboard-context-menu';
  menu.className = 'csboard-context-menu';
  menu.innerHTML = `
    ${price ? `<div class="csboard-ctx-price">${sign}${price.raw.toFixed(2)}</div>` : ''}
    <div class="csboard-ctx-name">${sanitize(marketName)}</div>
    <div class="csboard-ctx-sep"></div>
    <a class="csboard-ctx-item" href="https://buff.163.com/market/csgo#tab=selling&page_num=1&search=${encodedName}" target="_blank">
      <span class="csboard-ctx-icon">B</span> Lookup on BUFF
    </a>
    <a class="csboard-ctx-item" href="https://csfloat.com/search?market_hash_name=${encodedName}" target="_blank">
      <span class="csboard-ctx-icon">F</span> Lookup on CSFloat
    </a>
    <a class="csboard-ctx-item" href="https://pricempire.com/item/cs2/${encodedName}" target="_blank">
      <span class="csboard-ctx-icon">P</span> Lookup on Pricempire
    </a>
  `;

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 5}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 5}px`;
};

// (Trade Board postMessage hooks removed — TB feature stripped from prod build.)
const setupTradeEventListeners = (): void => {
  // No-op in csboard-extension-prod.
};

// ============================================================
// Enrich items with float/stickers via Steam API
// Uses GetInventoryItemsWithDescriptions with get_asset_properties=true
// ============================================================

const mergeFloatData = (apiItems: any[]): number => {
  let count = 0;
  const assetMap: Record<string, any> = {};
  for (const item of apiItems) {
    if (item.assetid) assetMap[item.assetid] = item;
  }
  for (const item of combinedInventories) {
    const apiItem = assetMap[item.assetid];
    if (!apiItem) continue;
    if ((apiItem.floatValue || apiItem.floatvalue) && !item.floatInfo?.floatvalue) {
      item.floatInfo = {
        floatvalue: apiItem.floatValue || apiItem.floatvalue,
        paintseed: apiItem.paintSeed || apiItem.paintseed,
      };
      // Recalculate pattern info now that we have paintseed
      if (!item.patternInfo && item.floatInfo.paintseed) {
        item.patternInfo = getPattern(item.market_hash_name, item.floatInfo.paintseed);
      }
      count++;
    }
  }
  return count;
};

const enrichWithAssetProperties = async (): Promise<void> => {
  // Wait for inventories to load
  let attempts = 0;
  while (combinedInventories.length === 0 && attempts < 30) {
    await new Promise(r => setTimeout(r, 500));
    attempts++;
  }
  if (combinedInventories.length === 0) return;

  // Get access token for OUR inventory
  const tokenScript = "document.querySelector('body').setAttribute('steamToken', document.getElementById('application_config')?.getAttribute('data-loyalty_webapi_token')?.replace(/\"/g,'') || '');";
  const accessToken = injectScript(tokenScript, true, 'getToken', 'steamToken');

  let enriched = 0;

  // 1. Enrich OUR items via GetInventoryItemsWithDescriptions (needs access token)
  if (accessToken && userSteamID) {
    try {
      const result = await new Promise<any>((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: 'FETCH_INVENTORY_WITH_PROPERTIES', data: { accessToken, steamId: userSteamID } },
          (response) => {
            if (chrome.runtime.lastError) { reject(chrome.runtime.lastError.message); return; }
            if (response?.error) { reject(response.error); return; }
            resolve(response);
          }
        );
      });
      if (result?.items) {
        enriched += mergeFloatData(result.items);
        logger.info('Enriched OUR items', { apiItems: result.items.length, enriched });
      }
    } catch (err) {
      logger.warn('Failed to enrich our items', { error: String(err) });
    }
  }

  // 2. Enrich PARTNER items via /tradeoffer/new/partnerinventory/ (no access token needed)
  if (partnerSteamID) {
    try {
      // Get sessionid from page
      const sessionScript = "document.querySelector('body').setAttribute('sid', typeof g_sessionID !== 'undefined' ? g_sessionID : '');";
      const sessionId = injectScript(sessionScript, true, 'getSID', 'sid');

      if (sessionId) {
        const url = `https://steamcommunity.com/tradeoffer/new/partnerinventory/?sessionid=${sessionId}&partner=${partnerSteamID}&appid=730&contextid=2`;
        const resp = await fetch(url, {
          credentials: 'include',
          headers: { Referer: window.location.href },
        });

        if (resp.ok) {
          const body = await resp.json();
          if (body.success && body.rgAssetProperties) {
            // Parse rgAssetProperties: { assetid: {propid: {propertyid, int_value, float_value}} }
            const propItems: any[] = [];
            for (const [assetId, propsObj] of Object.entries(body.rgAssetProperties as Record<string, any>)) {
              let floatValue: number | null = null;
              let paintSeed: number | null = null;
              const props = Array.isArray(propsObj) ? propsObj : Object.values(propsObj);
              for (const p of props as any[]) {
                if (!p) continue;
                if (p.propertyid === 1 && p.int_value) paintSeed = parseInt(p.int_value);
                if (p.propertyid === 2 && p.float_value) floatValue = parseFloat(p.float_value);
              }
              propItems.push({ assetid: assetId, floatValue, paintSeed });
            }
            enriched += mergeFloatData(propItems);
            logger.info('Enriched PARTNER items via partnerinventory', {
              propsCount: Object.keys(body.rgAssetProperties).length,
              enriched,
            });
          } else {
            logger.warn('partnerinventory: no rgAssetProperties', { keys: Object.keys(body) });
          }
        } else {
          logger.warn('partnerinventory fetch failed', { status: resp.status });
        }
      }
    } catch (err) {
      logger.warn('Failed to enrich partner items', { error: String(err) });
    }
  }

  if (enriched > 0) {
    document.querySelectorAll('[data-processed]').forEach((el) => {
      el.removeAttribute('data-processed');
      el.removeAttribute('data-colorful');
      el.querySelectorAll('.floatIndicator, .dopplerPhase, .patternIndicator').forEach(e => e.remove());
    });
    addPerItemInfo(userSteamID);
    addPerItemInfo(partnerSteamID);
    logger.info('Float enrichment complete', { enriched });
  }
};

// ============================================================
// MAIN INIT — cs2trader flow
// ============================================================

async function init() {
  // 1. Init price engine
  await priceEngine.init();

  // 2. Get offer ID from URL first (no injectScript needed)
  offerID = getOfferID();

  // 2.5. cs2trader: clickChangeOfferAutomatically — auto-click "Change Offer" button
  // MUST happen BEFORE getting inventories, because on existing offers the trade UI
  // isn't loaded until Change Offer is clicked
  if (offerID !== 'new') {
    const changeOfferButton = document.querySelector('.readystate.modify_trade_offer') as HTMLElement;
    if (changeOfferButton) {
      changeOfferButton.click();
      // Wait for Steam to load the trade UI after clicking Change Offer
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  // 3. Get Steam IDs via injectScript (cs2trader pattern)
  userSteamID = getUserSteamIDFromPage();
  partnerSteamID = getTradePartnerSteamID();

  // 4. Setup trade event listeners (CSBoard specific)
  setupTradeEventListeners();

  // 5. Context menu (BUFF, CSFloat, Pricempire) — always works even without inventories
  setupContextMenu();

  // 6. MAIN: getInventories(true) — loads both inventories, enriches with prices, adds to DOM
  getInventories(true);

  // 6.5. Enrich with float/stickers via Steam API (GetInventoryItemsWithDescriptions)
  // This runs async after initial load — adds float data to items that don't have it
  enrichWithAssetProperties().catch((err) => {
    logger.warn('Float enrichment failed (non-critical)', { error: String(err) });
  });

  // 7. Add function bars (cs2trader: addFunctionBars)
  addFunctionBars();

  // 8. (Trade Board banner removed — TB feature stripped from prod build.)

  // 9. When user switches inventory tabs OR your/their inventory — re-process items
  // Need delay because Steam renders items AFTER the click
  const reprocessOnTabSwitch = () => {
    // Immediate + delayed to catch Steam's lazy rendering
    addPerItemInfo(userSteamID);
    addPerItemInfo(partnerSteamID);
    singleClickControlClick();
    setTimeout(() => {
      // Force create all pages + re-apply indicators
      injectScript(`
        try {
          for (var i = 0; i < g_ActiveInventory.m_cPages; i++) {
            g_ActiveInventory.m_rgPages[i].EnsurePageItemsCreated();
            g_ActiveInventory.PreloadPageImages(i);
          }
        } catch(e) {}
      `, false);
      addPerItemInfo(userSteamID);
      addPerItemInfo(partnerSteamID);
      singleClickControlClick();

      // Re-apply saved sort for this inventory
      chrome.storage.local.get(['csboard_default_sort_offer'], (saved) => {
        if (saved.csboard_default_sort_offer && saved.csboard_default_sort_offer !== 'default') {
          sortItems(saved.csboard_default_sort_offer, 'offer');
          addPerItemInfo(userSteamID);
          addPerItemInfo(partnerSteamID);
        }
      });
    }, 1000);
    setTimeout(() => {
      addPerItemInfo(userSteamID);
      addPerItemInfo(partnerSteamID);
    }, 2500);
  };

  document.querySelectorAll('.inventory_user_tab').forEach((tab) => {
    tab.addEventListener('click', reprocessOnTabSwitch);
  });
  document.querySelectorAll('#inventory_select_their_inventory, #inventory_select_your_inventory').forEach((link) => {
    link.addEventListener('click', reprocessOnTabSwitch);
  });

  // 10. When user selects different game/app
  document.querySelectorAll('.appselect_options').forEach((appSelect) => {
    appSelect.addEventListener('click', () => {
      getInventories(false);
      setTimeout(() => getInventories(false), 2000);
    });
  });

  // 11. Trade action popup — add BUFF/CSFloat links (cs2trader pattern)
  const tradeActionPopup = document.getElementById('trade_action_popup');
  // Fallback: try other possible popup IDs
  const popupEl = tradeActionPopup
    || document.querySelector('.trade_action_popup')
    || document.querySelector('[id*="action_popup"]')
    || document.querySelector('.popup_menu');
  logger.info('Trade action popup element', {
    found: !!popupEl,
    id: popupEl?.id || 'none',
    tag: popupEl?.tagName || 'none',
  });
  // Add BUFF/CSFloat links to item popup — poll-based approach
  // Steam's popup doesn't reliably trigger MutationObserver
  // Inject BUFF/CSFloat links into trade slot popup
  // Listen for clicks on .slot_actionmenu_button (the arrow on each trade slot item)
  document.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.slot_actionmenu_button');
    if (!btn) return;

    // Wait for Steam to open the popup
    setTimeout(() => {
      const popup = document.getElementById('trade_action_popup');
      if (!popup) return;

      // Get assetid from the slot's item element
      const slot = btn.closest('.itemHolder');
      const itemEl = slot?.querySelector('.item') as HTMLElement;
      if (!itemEl) return;

      const assetID = getAssetIDOfElement(itemEl);
      if (!assetID) return;

      const item = getItemByAssetID(combinedInventories, assetID);
      // Fallback: try classid lookup
      let itemName = item?.market_hash_name;
      if (!itemName) {
        const dataAttr = itemEl.getAttribute('data-economy-item');
        if (dataAttr) {
          const parts = dataAttr.split('/');
          const classid = parts[2] || '';
          const instanceid = parts[3] || '0';
          const fallback = combinedInventories.find((i: any) =>
            i.classid === classid && (i.instanceid === instanceid || instanceid === '0')
          );
          if (fallback) itemName = fallback.market_hash_name;
        }
      }
      if (!itemName) return;

      // Find where to inject (static actions section or end of popup)
      const staticActions = popup.querySelector('#trade_action_popup_staticactions') || popup;

      // Remove old links
      staticActions.querySelectorAll('.csboard-popup-link').forEach(el => el.remove());

      const addLink = (text: string, href: string) => {
        const a = document.createElement('a');
        a.textContent = text;
        a.className = 'popup_menu_item csboard-popup-link';
        a.href = href;
        a.target = '_blank';
        staticActions.appendChild(a);
      };

      const clickedItem = combinedInventories.find((i: any) => i.market_hash_name === itemName || i.name === itemName);
      const cDPhase = clickedItem?.dopplerPhase;
      addLink('Lookup on BUFF', getBuffLink(itemName, cDPhase));
      addLink('Lookup on CSFloat', getCsFloatLink(itemName, { defIndex: clickedItem?.defIndex, paintIndex: clickedItem?.paintIndex, dopplerPhase: cDPhase }));
    }, 100);
  });

  // 12. Styles are in csboard-overlay.css (injected via manifest)

  // 12. Listen for settings changes (currency/priceSource synced from CSBoard website)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes['csboard_settings']) {
      // Settings changed (currency or priceSource) — reload price engine and re-render
      (async () => {
        await priceEngine.reload();
        // Clear processed flags so items get re-rendered with new currency
        document.querySelectorAll('[data-processed]').forEach((el) => {
          el.removeAttribute('data-processed');
          el.querySelectorAll('.priceIndicator, .buffBidIndicator, .floatIndicator, .exteriorSTInfo, .stickerPrice').forEach((tag) => tag.remove());
        });
        addPerItemInfo(userSteamID);
        addPerItemInfo(partnerSteamID);
        addInTradeTotals('your');
        addInTradeTotals('their');
        addPLInfo();
      })().catch(() => {});
    }
  });

  // Remove CSFloat overlays continuously
  const csFloatObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLElement && node.tagName && node.tagName.toLowerCase().startsWith('csfloat')) {
          node.remove();
        }
      }
    }
  });
  csFloatObserver.observe(document.getElementById('mainContent') || document.body, { childList: true, subtree: true });

  logger.info('Trade offer page ready');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => init().catch(() => {}));
} else {
  init().catch(() => {});
}
