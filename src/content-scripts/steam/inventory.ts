// ============================================================
// CSBOARD Content Script — Steam Inventory Page
// ============================================================
// Injected on: steamcommunity.com/id/*/inventory
//              steamcommunity.com/profiles/*/inventory
//
// Architecture (following cs2trader EXACTLY):
// 1. injectScript() — synchronous page-context execution via onreset trick
// 2. getItemInfoFromPage(appID, contextID) — reads UserYou.getInventory()
// 3. Prices from priceEngine (chrome.storage.local)
// 4. addPerItemInfo() — adds price tags to DOM elements
// 5. MutationObserver for page changes
// 6. Valuation banner with total value

import { priceEngine } from '../../shared/price-engine';
import { createLogger } from '../../shared/logger';
import { injectScript } from '../../shared/inject';
import {
  getIDsFromElement, getItemByIDs, addPriceIndicator,
  addFloatIndicator, addSSTandExtIndicators, resizeTradeProtectionIcon,
  makeItemColorful, addTradeHoldBadge, parseTradability, addDopplerPhase,
  addPatternIndicator, getBuffLink, getCsFloatLink,
} from '../../shared/items';
import { getPattern } from '../../shared/patternDetector';
import { getDopplerInfo } from '../../shared/dopplerPhases';
import { decodeHex } from '@csfloat/cs2-inspect-serializer';

const logger = createLogger('inventory');

// ============================================================
// State (cs2trader pattern: module-level variables)
// ============================================================

let items: any[] = [];
let inventoryTotal = 0;
let inventoryOwnerID = '';

// ============================================================
// cs2trader: getInventoryOwnerID — via injectScript
// ============================================================

const getInventoryOwnerID = (): string => {
  const script = "document.querySelector('body').setAttribute('inventoryOwnerID', UserYou.GetSteamId());";
  return injectScript(script, true, 'getInventoryOwnerID', 'inventoryOwnerID') || '';
};

// ============================================================
// cs2trader: getItemInfoFromPage(appID, contextID) — EXACT PORT
// ============================================================

const getItemInfoFromPage = (appID: string, contextID: string): any[] | null => {
  // Use unique attribute per context to avoid cross-contamination between calls
  const attrName = `inventoryInfo_${appID}_${contextID}`;
  // Clear previous value so injectScript re-runs the script
  document.body.removeAttribute(attrName);

  const getItemsScript = `
    try {
      inventory = UserYou.getInventory(${appID},${contextID});
      trimmedAssets = [];
      var assetProps = {};
      try { assetProps = inventory.m_rgAssetProperties || {}; } catch(e) {}

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
              if (p) safeProp.push({propertyid:p.propertyid,int_value:p.int_value||null,float_value:p.float_value||null,string_value:p.string_value||null});
            }
          }
        } catch(e) {}
        trimmedAssets.push({
          amount: asset.amount,
          assetid: asset.assetid,
          classid: asset.classid,
          contextid: asset.contextid,
          instanceid: asset.instanceid,
          appid: asset.appid.toString(),
          properties: safeProp,
          name: desc.name || '',
          market_hash_name: desc.market_hash_name || '',
          name_color: desc.name_color || '',
          icon_url: desc.icon_url || '',
          tradable: desc.tradable,
          marketable: desc.marketable,
          type: desc.type || '',
          tags: desc.tags || [],
          descriptions: desc.descriptions || [],
          owner_descriptions: desc.owner_descriptions || [],
        });
      }
      document.querySelector('body').setAttribute('${attrName}', JSON.stringify(trimmedAssets));
    } catch(e) {
      document.querySelector('body').setAttribute('${attrName}', JSON.stringify({error: e.toString()}));
    }
  `;
  const raw = injectScript(getItemsScript, true, 'getInventory_' + contextID, attrName) || '[]';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.error) {
      logger.error('getItemInfoFromPage failed in page context', { error: parsed.error });
      return null;
    }
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

// ============================================================
// Build inventory item structure with prices
// ============================================================

const buildInventory = (rawItems: any[]): { items: any[]; total: number } => {
  let total = 0;
  const duplicates: Record<string, { num: number; instances: string[] }> = {};

  rawItems.forEach((item) => {
    const name = item.market_hash_name || '';
    if (!name) return;
    if (duplicates[name] === undefined) {
      duplicates[name] = { num: 1, instances: [item.assetid] };
    } else {
      duplicates[name].num += 1;
      duplicates[name].instances.push(item.assetid);
    }
  });

  const builtItems: any[] = [];

  rawItems.forEach((item) => {
    const marketHashName = item.market_hash_name || '';
    if (!marketHashName) return;

    // Detect doppler phase for phase-specific pricing
    const iconUrl = item.icon_url || '';
    const dopplerInfo = iconUrl ? getDopplerInfo(iconUrl) : null;
    const dopplerPhase = dopplerInfo?.name; // "Phase 2", "Sapphire", etc.

    let price: { price: number; display: string } | undefined;
    const priceData = priceEngine.getPrice(marketHashName, dopplerPhase);
    if (priceData) {
      price = { price: priceData.raw, display: priceData.display };
      total += priceData.raw;
    }

    // Parse tradability
    const tradInfo = parseTradability(
      item.tradable ?? 0,
      item.descriptions,
      item.owner_descriptions,
    );

    // Steam m_rgAssetProperties: 1=paintSeed, 2=float, 6=protobuf hex (full item data)
    let floatValue: number | null = null;
    let paintSeed: number | null = null;
    let defIndex: number | null = null;
    let paintIndex: number | null = null;
    if (item.properties) {
      const props = Array.isArray(item.properties) ? item.properties : Object.values(item.properties);
      for (const prop of props as any[]) {
        if (!prop) continue;
        if (prop.propertyid === 1 && prop.int_value) paintSeed = parseInt(prop.int_value);
        if (prop.propertyid === 2 && prop.float_value) floatValue = parseFloat(prop.float_value);
        // propertyid 6 = protobuf hex certificate — decode for defindex, paintindex, stickers etc.
        if (prop.propertyid === 6 && prop.string_value) {
          try {
            const decoded = decodeHex(prop.string_value);
            if (decoded.defindex) defIndex = decoded.defindex;
            if (decoded.paintindex) paintIndex = decoded.paintindex;
            // Use decoded paintseed/paintwear as fallback if not from propertyid 1/2
            if (!paintSeed && decoded.paintseed) paintSeed = decoded.paintseed;
            if (!floatValue && decoded.paintwear) floatValue = decoded.paintwear;
          } catch { /* invalid hex, skip */ }
        }
      }
    }
    if (floatValue !== null && (isNaN(floatValue) || floatValue <= 0)) floatValue = null;

    // cs2trader EXACT: parse stickers from description.name === 'sticker_info'
    // Format: {name: 'sticker_info', value: '<html with sticker names>'}
    // Sticker names are after "><br>" then after ": ", comma-separated, before "</center>"
    let stickerTotal = 0;
    const descriptions = item.descriptions || [];
    for (const d of descriptions) {
      if (d && (d.name === 'sticker_info' || d.name === 'keychain_info')) {
        const val = d.value || '';
        // cs2trader: names = value.split('><br>')[1].split(': ')[1].split('</center>')[0].split(', ')
        const afterBr = val.split('><br>')[1];
        if (afterBr) {
          const afterColon = afterBr.split(': ')[1];
          if (afterColon) {
            const nameStr = afterColon.split('</center>')[0];
            const names = nameStr.split(', ');
            const prefix = d.name === 'sticker_info' ? 'Sticker' : 'Charm';
            for (const name of names) {
              const fullName = `${prefix} | ${name.trim()}`;
              const sp = priceEngine.getPrice(fullName);
              if (sp) stickerTotal += sp.raw;
            }
          }
        }
      }
    }

    const itemName = item.name || '';
    const patternInfo = getPattern(marketHashName, paintSeed);

    builtItems.push({
      name: itemName,
      market_hash_name: marketHashName,
      name_color: item.name_color || '',
      classid: item.classid || '',
      instanceid: item.instanceid || '',
      assetid: item.assetid || '',
      appid: item.appid || '730',
      contextid: item.contextid || '2',
      marketable: item.marketable || 0,
      tradable: item.tradable || 0,
      position: item.pos || 0,
      iconURL: item.icon_url || '',
      type: { key: item.type || 'other' },
      isStatrack: itemName.includes('StatTrak'),
      isSouvenir: itemName.includes('Souvenir'),
      duplicates: duplicates[marketHashName] || { num: 1, instances: [item.assetid] },
      owner: item.owner || inventoryOwnerID,
      price,
      tags: item.tags || [],
      descriptions: item.descriptions || [],
      tradabilityShort: tradInfo.tradabilityShort,
      dopplerPhase,
      floatValue,
      paintSeed,
      defIndex,
      paintIndex,
      patternInfo,
      stickerTotal,
    });
  });

  return {
    items: builtItems.sort((a, b) => (a.position || 0) - (b.position || 0)),
    total,
  };
};

// ============================================================
// cs2trader EXACT: addPerItemInfo — adds price tags to DOM elements
// ============================================================
// cs2trader uses: document.querySelectorAll('.item.app730')
// Each element has id="730_2_ASSETID"
// Match via getIDsFromElement(el, 'inventory') → getItemByIDs(items, appID, contextID, assetID)
// NO data-economy-item lookup — that attribute is on a CHILD <a>, not the .item div

const addPerItemInfo = (): void => {
  const itemElements = document.querySelectorAll('.item.app730');
  if (itemElements.length === 0) {
    // Inventory not loaded yet, retry (cs2trader exact pattern)
    setTimeout(addPerItemInfo, 1000);
    return;
  }

  itemElements.forEach((itemElement) => {
    const el = itemElement as HTMLElement;
    if (el.getAttribute('data-processed') === 'true') return;

    // cs2trader exact: if element has no id, inventory not loaded yet
    if (!el.id) {
      setTimeout(addPerItemInfo, 1000);
      return;
    }

    // cs2trader exact: parse element id "730_2_ASSETID"
    const IDs = getIDsFromElement(el, 'inventory');
    if (!IDs) return;

    let item = getItemByIDs(items, IDs.appID, IDs.contextID, IDs.assetID);
    // Fallback: try matching by assetid only (contextid may differ for hold items)
    if (!item) {
      item = items.find((i: any) => i.assetid === IDs.assetID) ?? null;
    }

    // Remove CSFloat injected elements (Shadow DOM — CSS can't hide them)
    el.querySelectorAll('[class*="csfloat"], csfloat-item-row-wrapper, csfloat-inventory-item-holder-metadata').forEach(e => e.remove());
    // Also remove by tag prefix
    [...el.children].forEach(child => {
      if (child.tagName && child.tagName.toLowerCase().startsWith('csfloat')) child.remove();
    });

    if (!item) {
      // Fallback for items not in m_rgAssets (hold items etc):
      // Try to get market_hash_name from data-economy-item on child <a>
      const link = el.querySelector('a[data-economy-item]');
      if (link) {
        const dataAttr = link.getAttribute('data-economy-item') || '';
        const parts = dataAttr.split('/');
        const classid = parts[2] || '';
        const instanceid = parts[3] || '0';
        // Try to find by classid in our items
        const fallbackItem = items.find((i: any) => i.classid === classid && (i.instanceid === instanceid || instanceid === '0'));
        if (fallbackItem) {
          makeItemColorful(el, fallbackItem.tags, fallbackItem.name_color, fallbackItem.market_hash_name || fallbackItem.name, fallbackItem.iconURL);
          addPriceIndicator(el, fallbackItem.price);
          if (fallbackItem.floatValue) addFloatIndicator(el, fallbackItem.floatValue, 4);
          addSSTandExtIndicators(el, fallbackItem);
          addDopplerPhase(el, fallbackItem.iconURL);
          addPatternIndicator(el, fallbackItem.patternInfo);
          if (fallbackItem.tradabilityShort) addTradeHoldBadge(el, fallbackItem.tradabilityShort);
          resizeTradeProtectionIcon(el);
          el.setAttribute('data-processed', 'true');
        }
      }
      return;
    }

    // cs2trader: makeItemColorful — set background/border by rarity, doppler gets phase color
    makeItemColorful(el, item.tags, item.name_color, item.market_hash_name || item.name, item.iconURL);

    // cs2trader: price indicator (bottom-left)
    addPriceIndicator(el, item.price);

    // cs2trader: float indicator (above price, smaller)
    if (item.floatValue) {
      addFloatIndicator(el, item.floatValue, 4);
    }

    // cs2trader: exterior + stattrak/souvenir + sticker price (top-right)
    addSSTandExtIndicators(el, item);

    // cs2trader: doppler phase badge
    addDopplerPhase(el, item.iconURL);

    // Pattern indicator (fade %, marble fade, case hardened blue %)
    addPatternIndicator(el, item.patternInfo);

    // cs2trader: trade hold badge ("7d") — top-left
    if (item.tradabilityShort) {
      addTradeHoldBadge(el, item.tradabilityShort);
    }

    // Resize trade protection icon (cs2trader: 20px, repositioned)
    resizeTradeProtectionIcon(el);

    // Store market_hash_name on element for context menu
    if (item.market_hash_name) {
      el.setAttribute('data-market-hash-name', item.market_hash_name);
    }

    el.setAttribute('data-processed', 'true');
  });
};

// ============================================================
// Valuation banner
// ============================================================

const updateValuationBanner = (): void => {
  document.getElementById('csboard-valuation')?.remove();

  // Show banner as soon as we have items — even if priceEngine hasn't filled
  // in totals yet. Empty/loading state gets a placeholder.
  if (items.length === 0) return;

  const settings = priceEngine.getSettings();
  const sign = settings.currency === 'USD' ? '$' : settings.currency + ' ';
  const valueText = inventoryTotal > 0
    ? `${sign}${inventoryTotal.toFixed(2)}`
    : 'loading…';

  const banner = document.createElement('div');
  banner.id = 'csboard-valuation';
  banner.className = 'csboard-valuation-bar';
  banner.innerHTML = `
    <span>CSBOARD</span> —
    Value: <span class="csboard-val-price">${valueText}</span> ·
    Source: <span class="csboard-val-source">${settings.priceSource}</span> ·
    Items: <strong>${items.length}</strong>
  `;

  ensureHeaderBar()?.appendChild(banner);
};

// One persistent flex container that holds both the valuation banner and the
// sorting dropdown, sitting just below the "COUNTER-STRIKE 2" page logo so it
// never pushes the right-side item info panel down.
const ensureHeaderBar = (): HTMLElement | null => {
  let bar = document.getElementById('csboard-header-bar') as HTMLElement | null;
  if (bar?.isConnected) return bar;

  bar = document.createElement('div');
  bar.id = 'csboard-header-bar';
  bar.style.cssText =
    'display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:14px; margin:8px 0; padding:0 4px;';

  const anchor =
    document.querySelector('#inventory_logos') ||
    document.querySelector('.filter_ctn.inventory_filters') ||
    document.querySelector('.filter_ctn');
  if (anchor) {
    anchor.insertAdjacentElement('afterend', bar);
    return bar;
  }
  const fallback =
    document.querySelector('.profile_small_header_additional') ||
    document.getElementById('inventories');
  if (fallback) {
    fallback.insertBefore(bar, fallback.firstChild);
    return bar;
  }
  return null;
};

// ============================================================
// Context menu for inventory items (BUFF, CSFloat, Pricempire)
// ============================================================

const setupContextMenu = (): void => {
  document.addEventListener('contextmenu', (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const itemEl = target.closest('[data-market-hash-name]') || target.closest('.item.app730.context2');
    if (!itemEl) return;

    let name = itemEl.getAttribute('data-market-hash-name');
    let foundItem: any = null;
    if (!name) {
      const IDs = getIDsFromElement(itemEl as HTMLElement, 'inventory');
      if (IDs) {
        foundItem = getItemByIDs(items, IDs.appID, IDs.contextID, IDs.assetID);
        if (!foundItem) foundItem = items.find((i: any) => i.assetid === IDs.assetID);
        if (foundItem) name = foundItem.market_hash_name;
      }
    } else {
      foundItem = items.find((i: any) => i.market_hash_name === name);
    }
    if (!name) return;

    e.preventDefault();

    // Remove old menu
    document.getElementById('csboard-context-menu')?.remove();

    const dPhase = foundItem?.dopplerPhase;
    const price = priceEngine.getPrice(name, dPhase);
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
      <div class="csboard-ctx-name">${sanitize(name)}${dPhase ? ` <span style="color:#8bb9e0">${dPhase}</span>` : ''}</div>
      <div class="csboard-ctx-sep"></div>
      <a class="csboard-ctx-item" href="${getBuffLink(name, dPhase)}" target="_blank">
        <span class="csboard-ctx-icon">B</span> Lookup on BUFF
      </a>
      <a class="csboard-ctx-item" href="${getCsFloatLink(name, { defIndex: foundItem?.defIndex, paintIndex: foundItem?.paintIndex, dopplerPhase: dPhase })}" target="_blank">
        <span class="csboard-ctx-icon">F</span> Lookup on CSFloat
      </a>
      <a class="csboard-ctx-item" href="https://pricempire.com/item/cs2/${encodeURIComponent(name)}" target="_blank">
        <span class="csboard-ctx-icon">P</span> Lookup on Pricempire
      </a>
    `;

    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    document.body.appendChild(menu);

    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 5}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 5}px`;
  });

  document.addEventListener('click', () => {
    document.getElementById('csboard-context-menu')?.remove();
  });
};

// ============================================================
// cs2trader EXACT: LoadMoreAssets — force Steam to load ALL items
// By default Steam only loads first 75 items (3 pages).
// g_ActiveInventory.LoadMoreAssets(1000) loads everything including hold items.
// ============================================================

// Load ALL items from ALL contexts (2 = tradable, 16 = hold)
// Steam paginates m_rgAssets — LoadMoreAssets(1000) forces full load
const loadFullInventory = (): void => {
  if (document.querySelector('body')?.getAttribute('csboard_allItemsLoaded') === 'true') {
    logger.info('Full inventory already loaded');
    onFullInventoryLoad();
    return;
  }

  // Load ALL items for BOTH context 2 AND context 16
  // g_ActiveInventory is only the current context — we need both explicitly
  const loadScript = `
    try {
      var loaded = 0;
      var total = 0;
      function checkDone() {
        loaded++;
        if (loaded >= total) {
          // Re-init page elements for active inventory
          try {
            for (var i = 0; i < g_ActiveInventory.m_cPages; i++) {
              g_ActiveInventory.m_rgPages[i].EnsurePageItemsCreated();
              g_ActiveInventory.PreloadPageImages(i);
            }
          } catch(e) {}
          document.querySelector('body').setAttribute('csboard_allItemsLoaded', 'true');
        }
      }

      // Context 2 (tradable)
      var inv2 = UserYou.getInventory(730, 2);
      if (inv2 && inv2.LoadMoreAssets) {
        total++;
        inv2.LoadMoreAssets(1000).done(function() {
          try {
            for (var i = 0; i < inv2.m_cPages; i++) {
              inv2.m_rgPages[i].EnsurePageItemsCreated();
              inv2.PreloadPageImages(i);
            }
          } catch(e) {}
          checkDone();
        });
      }

      // Context 16 (trade-protected / hold)
      var inv16 = UserYou.getInventory(730, 16);
      if (inv16 && inv16.LoadMoreAssets) {
        total++;
        inv16.LoadMoreAssets(1000).done(function() {
          try {
            for (var i = 0; i < inv16.m_cPages; i++) {
              inv16.m_rgPages[i].EnsurePageItemsCreated();
              inv16.PreloadPageImages(i);
            }
          } catch(e) {}
          checkDone();
        });
      }

      // If neither had LoadMoreAssets, mark done immediately
      if (total === 0) {
        document.querySelector('body').setAttribute('csboard_allItemsLoaded', 'true');
      }
    } catch(e) {
      console.error('[CSBOARD] LoadMoreAssets error:', e);
    }
  `;

  logger.info('Triggering LoadMoreAssets for ctx 2 + 16...');
  const result = injectScript(loadScript, true, 'loadFullInventory', 'csboard_allItemsLoaded');

  if (result === null) {
    logger.debug('LoadMoreAssets pending, retrying in 2s');
    setTimeout(loadFullInventory, 2000);
  } else {
    logger.info('LoadMoreAssets complete (both contexts)');
    onFullInventoryLoad();
  }
};

const readAllContextItems = (): any[] => {
  // Read from BOTH context 2 and context 16
  const ctx2 = getItemInfoFromPage('730', '2') || [];
  const ctx16 = getItemInfoFromPage('730', '16') || [];
  // Dedupe by assetid
  const seen = new Set<string>();
  const merged: any[] = [];
  for (const item of [...ctx2, ...ctx16]) {
    if (!seen.has(item.assetid)) {
      seen.add(item.assetid);
      merged.push(item);
    }
  }
  return merged;
};

const onFullInventoryLoad = (): void => {
  const rawItems = readAllContextItems();

  if (rawItems.length > 0 && rawItems.length > items.length) {
    const result = buildInventory(rawItems);
    items = result.items;
    inventoryTotal = result.total;

    logger.info('Full inventory loaded (ctx 2+16)', {
      items: items.length,
      rawItems: rawItems.length,
      total: inventoryTotal.toFixed(2),
    });

    // Reset processed flags so new items get indicators
    document.querySelectorAll('[data-processed]').forEach((el) => el.removeAttribute('data-processed'));
    addPerItemInfo();
    updateValuationBanner();
    // cs2trader: sort ONCE after full inventory loaded
    doInitSorting();
  } else {
    logger.debug('LoadMoreAssets: no new items', {
      current: items.length, fromPage: rawItems.length,
    });
    addPerItemInfo();
    doInitSorting();
  }
};

let loadAttempts = 0;

const loadInventoryData = (): void => {
  loadAttempts++;

  // Use inventoryExtractor.js to read ALL contexts (2 + 16) from m_rgAssets
  loadInventoryViaFallback();

  // Also trigger LoadMoreAssets to ensure Steam loads ALL items
  // (extractor will re-read after LoadMoreAssets completes)
  loadFullInventory();
};

const _loadInventoryDataLegacy = (): void => {
  loadAttempts++;
  const rawItems = getItemInfoFromPage('730', '2');

  if (rawItems && rawItems.length > 0) {
    const result = buildInventory(rawItems);
    items = result.items;
    inventoryTotal = result.total;
    addPerItemInfo();
    updateValuationBanner();
  } else if (loadAttempts < 60) {
    setTimeout(_loadInventoryDataLegacy, 1000);
  } else {
    logger.warn('Could not load inventory after 30 attempts, trying fallback');
    // Fallback: try the postMessage/injectScriptAsFile approach
    loadInventoryViaFallback();
  }
};

// Fallback: inject inventoryExtractor.js and listen for postMessage
const loadInventoryViaFallback = (): void => {
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.type !== 'CSBOARD_INVENTORY_DATA') return;
    const invItems = event.data.items as Record<string, any>;
    if (!invItems || Object.keys(invItems).length === 0) return;

    // Convert to array format (keep original contextid — context 16 = hold items)
    const rawItems = Object.values(invItems).map((item: any) => ({
      assetid: item.assetid || '',
      classid: item.classid || '',
      instanceid: item.instanceid || '0',
      appid: item.appid || '730',
      contextid: item.contextid || '2',
      name: item.name || '',
      market_hash_name: item.market_hash_name || '',
      name_color: item.name_color || '',
      icon_url: item.icon_url || '',
      marketable: item.marketable || 0,
      tradable: item.tradable || 0,
      type: item.type || '',
      tags: item.tags || [],
      descriptions: item.descriptions || [],
      owner_descriptions: item.owner_descriptions || [],
      properties: item.properties || null,
      pos: 0,
      owner: inventoryOwnerID,
    }));

    // Only update if we got MORE items than before
    if (rawItems.length > items.length) {
      const oldCount = items.length;
      const result = buildInventory(rawItems);
      items = result.items;
      inventoryTotal = result.total;

      logger.info('Inventory loaded via extractor (ALL contexts)', { items: items.length, raw: rawItems.length, prev: oldCount });

      // Reset processed flags so all items get indicators
      document.querySelectorAll('[data-processed]').forEach((el) => el.removeAttribute('data-processed'));
      addPerItemInfo();
      updateValuationBanner();
      // Apply saved sort now that items are loaded
      applySavedSort();
    } else {
      logger.debug('Extractor returned same or fewer items', { current: items.length, new: rawItems.length });
      addPerItemInfo();
    }
  });

  // Inject the extractor script
  const existing = document.getElementById('csboard-inventory-extractor');
  if (existing) existing.remove();
  const script = document.createElement('script');
  script.id = 'csboard-inventory-extractor';
  script.src = chrome.runtime.getURL('injectToPage/inventoryExtractor.js');
  (document.head || document.documentElement).appendChild(script);
};

// ============================================================
// MutationObserver — reprocess on DOM changes
// ============================================================

const setupObserver = (): void => {
  const container = document.getElementById('inventories');
  if (!container) {
    setTimeout(setupObserver, 1000);
    return;
  }

  // cs2trader pattern: TWO observers
  // Observer 1: watch iteminfo0 for attribute changes (right panel switches)
  const iteminfo0 = document.getElementById('iteminfo0');
  if (iteminfo0) {
    const panelObserver = new MutationObserver(() => {
      // Right panel changed — update detail panel
      setTimeout(addRightSideElements, 100);
    });
    panelObserver.observe(iteminfo0, { attributes: true, subtree: false });
  }

  // Observer 2: watch #inventories for attribute changes (page switches)
  // cs2trader: subtree: false, attributes: true — catches Steam toggling page visibility
  let lastTriggered = 0;
  const pageObserver = new MutationObserver(() => {
    if (items.length === 0) return;
    // Throttle to max 2x per second (cs2trader pattern)
    const now = Date.now();
    if (now - lastTriggered < 500) return;
    lastTriggered = now;
    addPerItemInfo();
  });
  pageObserver.observe(container, { attributes: true, subtree: true });
  logger.debug('Inventory observer started');
};

// ============================================================
// Lookup links injected next to the "Inspect in Game" button — cs2trader
// pattern. Survives Steam's right-panel rerenders because we re-run on every
// click + mutation, dedupe by removing stale .csboard-lookup-inline first.
// ============================================================

// Find every "anchor row" we can attach the lookup block beside. We support
// BOTH the old Steam UI (#iteminfo0 / #iteminfo1 with .hover_item_name) and
// the new redesigned UI which uses hash-randomised class names but keeps a
// link to https://store.steampowered.com/app/730/CounterStrike_2 with the
// game icon image as its child, plus an "Inspect in Game" link whose href
// starts with steam://run/730 (note: NEW UI = "run", OLD UI = "rungame").
//
// Each entry returned describes WHERE to insert the lookup block AND WHICH
// item name to use, so we don't depend on now-removed selectors.
type LookupAnchor = { row: Element; itemName: string };

const findLookupAnchors = (): LookupAnchor[] => {
  const seen = new Set<Element>();
  const out: LookupAnchor[] = [];

  // Walk every CS2-store-page link with an <img> inside (game-icon row).
  document.querySelectorAll<HTMLAnchorElement>(
    'a[href*="store.steampowered.com/app/730/CounterStrike"]'
  ).forEach((link) => {
    if (!link.querySelector('img')) return;
    const row = link.parentElement;
    if (!row || seen.has(row)) return;

    // Find item name: nearest h1 inside the same right-panel container.
    let scope: Element | null = row;
    let nameEl: Element | null = null;
    while (scope && !nameEl) {
      nameEl = scope.querySelector('h1');
      if (nameEl) break;
      scope = scope.parentElement;
      if (!scope || scope === document.body) break;
    }
    const itemName = nameEl?.textContent?.trim();
    if (!itemName) return;

    seen.add(row);
    out.push({ row, itemName });
  });

  // Fallback: the "Inspect in Game" button. Matches both new and old UIs.
  if (out.length === 0) {
    document.querySelectorAll<HTMLAnchorElement>(
      'a[href*="csgo_econ_action_preview"]'
    ).forEach((btn) => {
      const wrapper = btn.parentElement;
      if (!wrapper || seen.has(wrapper)) return;

      let scope: Element | null = wrapper;
      let nameEl: Element | null = null;
      while (scope && !nameEl) {
        nameEl = scope.querySelector('h1, .hover_item_name');
        if (nameEl) break;
        scope = scope.parentElement;
        if (!scope || scope === document.body) break;
      }
      const itemName = nameEl?.textContent?.trim();
      if (!itemName) return;

      seen.add(wrapper);
      out.push({ row: wrapper, itemName });
    });
  }

  return out;
};

const buildLookupBlock = (item: any, itemName: string): HTMLDivElement => {
  const dPhase = item?.dopplerPhase as string | undefined;
  const buffHref = getBuffLink(itemName, dPhase);
  const csfloatHref = getCsFloatLink(itemName, {
    defIndex: item?.defIndex,
    paintIndex: item?.paintIndex,
    dopplerPhase: dPhase,
  });
  const pricempireHref = `https://pricempire.com/item/cs2/${encodeURIComponent(itemName)}`;

  const block = document.createElement('div');
  block.className = 'csboard-lookup-inline';
  block.style.cssText =
    'margin: 8px 0; display: inline-flex; flex-wrap: wrap; gap: 6px; font-size: 12px; padding: 5px 6px; border: 1px solid rgb(56,64,77); background: rgb(43,48,57); border-radius: 3px;';
  block.innerHTML = `
    <a href="${buffHref}" target="_blank" rel="noopener" style="color:#ffd866; text-decoration:none; padding:2px 6px;">Buff</a>
    <a href="${csfloatHref}" target="_blank" rel="noopener" style="color:#7ec1ff; text-decoration:none; padding:2px 6px;">CSFloat</a>
    <a href="${pricempireHref}" target="_blank" rel="noopener" style="color:#9eff9e; text-decoration:none; padding:2px 6px;">Pricempire</a>
  `;
  return block;
};

const injectLookupLinksNearInspect = (_item?: any, _itemName?: string): void => {
  const tryInject = (): boolean => {
    const anchors = findLookupAnchors();
    if (anchors.length === 0) return false;

    // Drop stale blocks anywhere they sit — the right panel can re-render with
    // entirely different containers, so we don't restrict the cleanup scope.
    document.querySelectorAll('.csboard-lookup-inline').forEach((el) => el.remove());

    anchors.forEach(({ row, itemName }) => {
      // Skip if we've already injected immediately after this row this pass.
      const next = row.nextElementSibling as Element | null;
      if (next?.classList.contains('csboard-lookup-inline')) return;

      const item = items.find(
        (i: any) => i.market_hash_name === itemName || i.name === itemName,
      );
      const block = buildLookupBlock(item, itemName);
      row.insertAdjacentElement('afterend', block);
    });
    return true;
  };

  // Steam renders the right panel async after the click — try immediately,
  // then back off a few times so we catch whichever frame the panel lands in.
  if (tryInject()) return;
  const delays = [120, 320, 700, 1400];
  let i = 0;
  const next = () => {
    if (i >= delays.length) return;
    setTimeout(() => {
      if (!tryInject()) {
        i += 1;
        next();
      }
    }, delays[i]);
  };
  next();
};

// ============================================================
// Item detail panel — show price in right panel on click
// ============================================================

const setupItemClickListener = (): void => {
  document.addEventListener('click', (e: Event) => {
    const target = e.target as HTMLElement;
    if (!target.closest('[data-economy-item]') && !target.closest('.inventory_item_link') && !target.closest('.item.app730')) return;
    setTimeout(addRightSideElements, 300);
    setTimeout(injectLookupLinksNearInspect, 100);
  });
};

// Standalone observer for the Lookup block — independent of the legacy
// addRightSideElements path (which only runs on the old #iteminfo0/#iteminfo1
// UI). When Steam swaps the right item panel — old or new UI — the next
// matching CS2 game-icon row gets a fresh Buff/CSFloat/Pricempire block.
const setupLookupObserver = (): void => {
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      injectLookupLinksNearInspect();
    });
  };

  // Run once now in case the panel is already populated.
  injectLookupLinksNearInspect();

  const obs = new MutationObserver((mutations) => {
    // Ignore mutations caused by our own injected block.
    for (const m of mutations) {
      const added = Array.from(m.addedNodes);
      const removed = Array.from(m.removedNodes);
      const onlyOurs = (nodes: Node[]) =>
        nodes.length > 0 &&
        nodes.every(
          (n) =>
            n.nodeType === Node.ELEMENT_NODE &&
            (n as Element).classList?.contains('csboard-lookup-inline'),
        );
      if (onlyOurs(added) || onlyOurs(removed)) continue;
      schedule();
      return;
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
};

const addRightSideElements = (): void => {
  // Find the active item info panel (Steam uses iteminfo0 and iteminfo1, toggles visibility)
  let panel: HTMLElement | null = null;
  for (const id of ['iteminfo0', 'iteminfo1']) {
    const el = document.getElementById(id);
    if (el && el.style.display !== 'none') { panel = el; break; }
  }
  if (!panel) return;

  // Remove old csboard elements
  panel.querySelectorAll('.csboard-upper-module, .csboard-detail-price').forEach(e => e.remove());

  // Get the active item name
  const nameEl = panel.querySelector('.hover_item_name');
  const itemName = nameEl?.textContent?.trim();
  if (!itemName) return;

  // Find item in our data
  const item = items.find((i: any) => i.market_hash_name === itemName || i.name === itemName);
  const price = priceEngine.getPrice(itemName);
  const settings = priceEngine.getSettings();

  // Build upper module HTML
  const parts: string[] = [];

  // Price
  if (price) {
    parts.push(`<div class="csboard-detail-price">${settings.priceSource}: <strong>${price.display}</strong></div>`);
  }

  // Float
  if (item?.floatValue) {
    parts.push(`<div class="csboard-detail-float">Float: <strong>${item.floatValue.toFixed(10)}</strong></div>`);
  }

  // Paint seed
  if (item?.paintSeed) {
    parts.push(`<div class="csboard-detail-seed">Paint Seed: <strong>${item.paintSeed}</strong></div>`);
  }

  // Pattern info (fade %, marble fade, case hardened blue %)
  if (item?.patternInfo) {
    const pi = item.patternInfo;
    const label = pi.type === 'fade' ? 'Fade' : pi.type === 'marble_fade' ? 'Marble Fade' : 'Blue Gem';
    parts.push(`<div class="csboard-detail-pattern">${label}: <strong>${pi.value}</strong></div>`);
  }

  // Stickers with prices
  if (item?.descriptions) {
    for (const d of item.descriptions) {
      if (d && (d.name === 'sticker_info' || d.name === 'keychain_info')) {
        const val = d.value || '';
        const afterBr = val.split('><br>')[1];
        if (!afterBr) continue;
        const afterColon = afterBr.split(': ')[1];
        if (!afterColon) continue;
        const nameStr = afterColon.split('</center>')[0];
        const stickerNames = nameStr.split(', ');
        const prefix = d.name === 'sticker_info' ? 'Sticker' : 'Charm';

        // Extract icon URLs
        const iconURLs = val.split('src="').slice(1).map((s: string) => s.split('"')[0]);

        let totalStickerPrice = 0;
        const stickerHtml: string[] = [];
        stickerNames.forEach((sName: string, idx: number) => {
          const fullName = `${prefix} | ${sName.trim()}`;
          const sp = priceEngine.getPrice(fullName);
          if (sp) totalStickerPrice += sp.raw;
          const iconUrl = iconURLs[idx] || '';
          stickerHtml.push(`
            <div class="csboard-sticker-slot" title="${fullName}${sp ? ' (' + sp.display + ')' : ''}">
              ${iconUrl ? `<img src="${iconUrl}" width="48" height="36">` : ''}
              <span>${sName.trim()}</span>
              ${sp ? `<span class="csboard-sticker-price">${sp.display}</span>` : ''}
            </div>
          `);
        });

        if (stickerHtml.length > 0) {
          parts.push(`<div class="csboard-stickers-container">
            <div class="csboard-stickers-title">${prefix}s (Total: $${totalStickerPrice.toFixed(2)})</div>
            <div class="csboard-stickers-list">${stickerHtml.join('')}</div>
          </div>`);
        }
      }
    }
  }

  // Tradability
  if (item?.tradabilityShort) {
    parts.push(`<div class="csboard-detail-trade not_tradable">Trade Hold: ${item.tradabilityShort}</div>`);
  }

  // Lookup links go directly next to Steam's "Inspect in Game" button
  // (cs2trader pattern — survives Steam's frequent right-panel rerenders).
  injectLookupLinksNearInspect(item, itemName);

  if (parts.length === 0) return;

  // Find insertion point — try multiple selectors
  const insertPoint = panel.querySelector('[role="separator"]')
    || panel.querySelector('.item_desc_descriptors')
    || panel.querySelector('.item_desc_description')
    || nameEl?.parentElement
    || panel;

  const module = document.createElement('div');
  module.className = 'csboard-upper-module';
  module.innerHTML = parts.join('');

  if (insertPoint === panel) {
    panel.appendChild(module);
  } else {
    insertPoint.insertAdjacentElement('afterend', module);
  }
};

// ============================================================
// Sorting — cs2trader EXACT pattern
// Key: sort ONLY ONCE after allItemsLoaded (LoadMoreAssets done)
// ============================================================


// Sort by moving .itemHolder elements between .inventory_page containers
// Sorts whatever is currently in DOM — no page flipping hacks
const sortItems = (method: string): void => {
  doSort(method);
};

const doSort = (method: string): void => {
  const inventories = document.getElementById('inventories');
  if (!inventories) return;

  const inventoryPages = Array.from(inventories.querySelectorAll('.inventory_page'));
  const allHolders = Array.from(inventories.querySelectorAll('.itemHolder'));

  logger.info('Sort: DOM state', { holders: allHolders.length, pages: inventoryPages.length });
  if (allHolders.length === 0 || inventoryPages.length === 0) return;

  // Get item data for each holder
  const getItemForHolder = (holder: Element): any => {
    const itemEl = holder.querySelector('.item.app730');
    if (!itemEl) return null;
    const assetID = (itemEl as HTMLElement).id?.split('_')[2] || '';
    return items.find((i: any) => i.assetid === assetID) || null;
  };

  // Sort holders based on method
  const sortedHolders = allHolders.sort((a, b) => {
    const ia = getItemForHolder(a);
    const ib = getItemForHolder(b);
    if (!ia && !ib) return 0;
    if (!ia) return 1;
    if (!ib) return -1;

    if (method === 'price_desc') return (ib.price?.price ?? 0) - (ia.price?.price ?? 0);
    if (method === 'price_asc') return (ia.price?.price ?? 0) - (ib.price?.price ?? 0);
    if (method === 'name_asc') return (ia.market_hash_name || '').toLowerCase() < (ib.market_hash_name || '').toLowerCase() ? -1 : 1;
    if (method === 'name_desc') return (ia.market_hash_name || '').toLowerCase() > (ib.market_hash_name || '').toLowerCase() ? -1 : 1;
    if (method === 'float_asc') return (ia.floatValue ?? 999) - (ib.floatValue ?? 999);
    if (method === 'float_desc') return (ib.floatValue ?? -1) - (ia.floatValue ?? -1);
    // default: original order
    if (ia.contextid !== ib.contextid) return ia.contextid === '16' ? -1 : 1;
    return (ia.position || 0) - (ib.position || 0);
  });

  // Redistribute sorted holders into pages (25 per page)
  let holderIdx = 0;
  const ITEMS_PER_PAGE = 25;

  inventoryPages.forEach((page) => {
    // Remove all holders from page
    page.querySelectorAll('.itemHolder').forEach(h => h.remove());

    // Fill with sorted holders
    for (let i = 0; i < ITEMS_PER_PAGE && holderIdx < sortedHolders.length; i++) {
      const holder = sortedHolders[holderIdx];
      if (holder) page.appendChild(holder);
      holderIdx++;
    }
  });

  // If more holders than pages can fit, create additional pages (shouldn't happen but safety)
  logger.info('Sort complete', { method, sorted: sortedHolders.length, distributed: holderIdx });

  // Re-process indicators
  document.querySelectorAll('[data-processed]').forEach(el => el.removeAttribute('data-processed'));
  addPerItemInfo();
};

// cs2trader exact: doInitSorting — called ONCE after allItemsLoaded
let savedSortMode: string | null = null;
let initSortingDone = false;

const doInitSorting = (): void => {
  if (initSortingDone) return;
  initSortingDone = true;

  chrome.storage.local.get('csboard_default_sort_inventory', (data) => {
    const saved = data['csboard_default_sort_inventory'];
    if (saved) {
      savedSortMode = saved;
      const select = document.getElementById('csboard_inv_sort_mode') as HTMLSelectElement | null;
      if (select) select.value = saved;
    }
    // Sort whatever is in DOM now — no page flipping
    if (savedSortMode && savedSortMode !== 'default') {
      doSort(savedSortMode);
    }
  });
};

// No-op — kept for compatibility with calls from extractor/recheck
const applySavedSort = (): void => {
  // Sorting only happens via doInitSorting (after allItemsLoaded) or manual select change
};

const addInventorySortingBar = (): void => {
  if (document.getElementById('csboard-inv-sorting')) return;

  const bar = document.createElement('div');
  bar.id = 'csboard-inv-sorting';
  bar.className = 'functionBarRow';
  bar.innerHTML = `
    <span>Sorting:</span>
    <select id="csboard_inv_sort_mode">
      <option value="default">Default (position)</option>
      <option value="price_desc">Price (expensive to cheap)</option>
      <option value="price_asc">Price (cheap to expensive)</option>
      <option value="name_asc">Name (A to Z)</option>
      <option value="name_desc">Name (Z to A)</option>
      <option value="float_asc">Float (lowest to highest)</option>
      <option value="float_desc">Float (highest to lowest)</option>
      <option value="tradability_desc">Trade hold (longest first)</option>
      <option value="tradability_asc">Trade hold (shortest first)</option>
    </select>
    <button id="csboard_inv_sort_save" style="margin-left:4px;cursor:pointer;background:#3d6896;border:1px solid #4b8cbe;color:#c6d4df;padding:2px 8px;border-radius:2px;">Save</button>
  `;

  // Sit the sorting dropdown next to the valuation banner in the persistent
  // header bar (same flex row, wraps on narrow widths).
  const headerBar = ensureHeaderBar();
  if (headerBar) {
    headerBar.appendChild(bar);
  } else {
    const filterCtn = document.querySelector('.filter_ctn.inventory_filters')
      || document.querySelector('.filter_ctn');
    if (filterCtn) {
      filterCtn.insertAdjacentElement('afterend', bar);
    } else {
      const fallback = document.getElementById('inventories');
      if (fallback) fallback.insertBefore(bar, fallback.firstChild);
    }
  }

  const select = document.getElementById('csboard_inv_sort_mode') as HTMLSelectElement | null;
  if (select) {
    // Load saved preference into select (actual sorting happens in doInitSorting after allItemsLoaded)
    chrome.storage.local.get('csboard_default_sort_inventory', (data) => {
      const saved = data['csboard_default_sort_inventory'];
      if (saved && select) {
        select.value = saved;
        savedSortMode = saved;
      }
    });

    // Manual sort change
    select.addEventListener('change', () => {
      const mode = select.value;
      savedSortMode = mode;
      sortItems(mode);
    });

    const saveBtn = document.getElementById('csboard_inv_sort_save');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        chrome.storage.local.set({ csboard_default_sort_inventory: select.value });
        saveBtn.textContent = 'Saved!';
        setTimeout(() => { saveBtn.textContent = 'Save'; }, 1500);
      });
    }
  }
};

// ============================================================
// MAIN INIT
// ============================================================

async function init() {
  logger.info('Initializing inventory page');

  // 1. Init price engine
  await priceEngine.init();
  logger.info('Price engine ready', { items: priceEngine.itemCount });

  // 2. Get inventory owner ID via injectScript (cs2trader pattern)
  inventoryOwnerID = getInventoryOwnerID();
  logger.info('Inventory owner', { inventoryOwnerID });

  // 3. Load inventory data via injectScript
  loadInventoryData();

  // 4. Setup observer for DOM changes (page navigation etc.)
  setupObserver();

  // 5. Item click handler for detail panel
  setupItemClickListener();

  // 5b. Standalone observer that injects Buff/CSFloat/Pricempire links into
  //     the right item panel — works for both the old and new Steam UIs.
  setupLookupObserver();

  // 6. Context menu
  setupContextMenu();

  // 7. Periodic re-check: re-read m_rgAssets (BOTH contexts) every 5s
  let recheckCount = 0;
  const recheckInterval = setInterval(() => {
    recheckCount++;
    if (recheckCount > 12) { clearInterval(recheckInterval); return; } // Stop after 60s
    const rawItems = readAllContextItems();
    if (rawItems.length > items.length) {
      const oldCount = items.length;
      const result = buildInventory(rawItems);
      items = result.items;
      inventoryTotal = result.total;
      document.querySelectorAll('[data-processed]').forEach((el) => el.removeAttribute('data-processed'));
      addPerItemInfo();
      updateValuationBanner();
      logger.info('Recheck found more items', { old: oldCount, new: items.length });
      // Re-apply saved sort if items changed
      applySavedSort();
    }
  }, 5000);

  // 8. Listen for inventory app/context switches
  // cs2trader pattern: when user clicks on a game tab, reload data
  document.querySelectorAll('.games_list_tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      // Clear old items and reload after a delay (for new game context)
      setTimeout(() => {
        items = [];
        inventoryTotal = 0;
        // Reset processed flags
        document.querySelectorAll('[data-processed]').forEach((el) => {
          el.removeAttribute('data-processed');
        });
        loadInventoryData();
      }, 1500);
    });
  });

  // 9. Remove CSFloat overlays — they inject via Shadow DOM, CSS can't hide them
  // Use a MutationObserver to continuously remove CSFloat elements as they appear
  const csFloatObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLElement && node.tagName && node.tagName.toLowerCase().startsWith('csfloat')) {
          node.remove();
        }
      }
    }
  });
  const inventoriesEl = document.getElementById('inventories') || document.body;
  csFloatObserver.observe(inventoriesEl, { childList: true, subtree: true });
  // Also remove any already-present CSFloat elements
  document.querySelectorAll('.item.app730').forEach((el) => {
    [...el.children].forEach(child => {
      if (child.tagName && child.tagName.toLowerCase().startsWith('csfloat')) child.remove();
    });
  });
  logger.info('CSFloat overlay removal active');

  // 10. Listen for settings changes (currency/priceSource synced from CSBoard website)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes['csboard_settings']) {
      (async () => {
        await priceEngine.reload();
        // Clear all price tags and reprocess
        document.querySelectorAll('[data-processed]').forEach((el) => {
          el.removeAttribute('data-processed');
          el.querySelectorAll('.priceIndicator, .floatIndicator, .exteriorSTInfo, .stickerPrice').forEach((tag) => tag.remove());
        });
        // Rebuild inventory with new prices
        const rawItems = getItemInfoFromPage('730', '2');
        if (rawItems && rawItems.length > 0) {
          const result = buildInventory(rawItems);
          items = result.items;
          inventoryTotal = result.total;
      
        }
        addPerItemInfo();
        updateValuationBanner();
        // Refresh detail panel
        document.querySelectorAll('.csboard-detail-price').forEach((el) => el.remove());
      })().catch(() => {});
    }
  });

  // 11. Add sorting function bar (cs2trader style — Steam-native select)
  // Sorting disabled — was breaking the page
  addInventorySortingBar();

  logger.info('Inventory page ready');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => init().catch((e) => logger.error('Init failed', { error: String(e) })));
} else {
  init().catch((e) => logger.error('Init failed', { error: String(e) }));
}
