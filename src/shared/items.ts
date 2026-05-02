// ============================================================
// CSBOARD — Item Utilities (cs2trader pattern)
// ============================================================
// Ported from cs2trader's itemsToElementsToItems.js and utilsModular.js
// These are the core item lookup/matching utilities used everywhere.

import { getDopplerInfo as getDopplerInfoByIcon } from './dopplerPhases';

/**
 * Find a DOM element by app/context/asset IDs.
 * Trade offer pages use "item{appID}_{contextID}_{assetID}" format.
 * Inventory pages use "{appID}_{contextID}_{assetID}" format.
 */
export const findElementByIDs = (
  appID: string,
  contextID: string,
  assetID: string,
  type: string,
): HTMLElement | null => {
  const elementID = type.includes('offer')
    ? `item${appID}_${contextID}_${assetID}`
    : `${appID}_${contextID}_${assetID}`;
  return document.getElementById(elementID);
};

/**
 * Find an item in an items array by app/context/asset IDs.
 */
export const getItemByIDs = (
  items: any[],
  appID: string,
  contextID: string,
  assetID: string,
): any | null => {
  if (!items || items.length === 0) return null;
  return items.find((item) =>
    item.assetid === assetID && item.appid === appID && item.contextid === contextID
  ) ?? null;
};

/**
 * Extract app/context/asset IDs from an element's id attribute.
 * Trade offer format: "item730_2_12345" → { appID: "730", contextID: "2", assetID: "12345" }
 * Inventory format: "730_2_12345" → { appID: "730", contextID: "2", assetID: "12345" }
 */
export const getIDsFromElement = (
  element: HTMLElement | null,
  type: string,
): { appID: string; contextID: string; assetID: string } | null => {
  if (!element || !element.id || element.id.includes('anonymous_element')) return null;
  const IDs = element.id.split('_');
  return {
    appID: type === 'inventory' ? (IDs[0] ?? '') : (IDs[0]?.split('item')[1] ?? ''),
    contextID: IDs[1] ?? '',
    assetID: IDs[2] ?? '',
  };
};

/**
 * Get asset ID from an element (extracts from element id).
 */
export const getAssetIDOfElement = (element: HTMLElement): string => {
  const id = element.id || '';
  const parts = id.split('_');
  return parts[parts.length - 1] || '';
};

/**
 * Find an item in items array by asset ID only.
 */
export const getItemByAssetID = (items: any[], assetID: string): any | null => {
  if (!items || items.length === 0) return null;
  return items.find((item) => item.assetid === assetID) ?? null;
};

/**
 * Add a price indicator to an item element.
 * cs2trader style: .priceIndicator at bottom-left, white text, no background.
 */
export const addPriceIndicator = (
  itemElement: HTMLElement | null,
  price: { price: number; display: string } | undefined,
  _currency?: string,
): void => {
  if (!itemElement || !price) return;
  if (itemElement.querySelector('.priceIndicator')) return;

  itemElement.insertAdjacentHTML(
    'beforeend',
    `<div class="priceIndicator">${price.display}</div>`,
  );
};

/**
 * Extract exterior short name from item tags.
 * Returns: FN, MW, FT, WW, BS or null
 */
export const getExteriorShort = (tags: any[] | undefined): string | null => {
  if (!tags) return null;
  const exteriorTag = tags.find((t: any) => t.category === 'Exterior');
  if (!exteriorTag) return null;
  const map: Record<string, string> = {
    'Factory New': 'FN',
    'Minimal Wear': 'MW',
    'Field-Tested': 'FT',
    'Well-Worn': 'WW',
    'Battle-Scarred': 'BS',
  };
  return map[exteriorTag.localized_tag_name || exteriorTag.name] || null;
};

/**
 * Add float indicator to item element.
 * cs2trader exact: .floatIndicator positioned above .priceIndicator
 */
export const addFloatIndicator = (
  itemElement: HTMLElement | null,
  floatValue: number | string | null | undefined,
  digits: number = 5,
): void => {
  if (!itemElement || floatValue == null) return;
  if (itemElement.querySelector('.floatIndicator')) return;

  const fv = typeof floatValue === 'string' ? parseFloat(floatValue) : floatValue;
  if (isNaN(fv) || fv <= 0 || fv >= 1) return;

  itemElement.insertAdjacentHTML(
    'beforeend',
    `<div class="floatIndicator">${fv.toFixed(digits)}</div>`,
  );
};

/**
 * Add exterior, StatTrak/Souvenir, and sticker price indicators.
 * cs2trader exact: .exteriorSTInfo (top-right) + .stickerPrice (below exterior)
 */
export const addSSTandExtIndicators = (
  itemElement: HTMLElement | null,
  item: {
    isStatrack?: boolean;
    isSouvenir?: boolean;
    tags?: any[];
    stickerTotal?: number;
  },
): void => {
  if (!itemElement) return;
  if (itemElement.querySelector('.exteriorSTInfo')) return;

  const exterior = getExteriorShort(item.tags);
  const st = item.isStatrack ? 'ST' : '';
  const sv = item.isSouvenir ? 'S' : '';

  if (exterior || st || sv) {
    const parts: string[] = [];
    if (sv) parts.push(`<span class="souvenirYellow">${sv}</span>`);
    if (st) parts.push(`<span class="stattrakOrange">${st}</span>`);
    if (exterior) parts.push(`<span class="exteriorIndicator">${exterior}</span>`);
    itemElement.insertAdjacentHTML(
      'beforeend',
      `<div class="exteriorSTInfo">${parts.join('')}</div>`,
    );
  }

  if (item.stickerTotal && item.stickerTotal > 0.01) {
    itemElement.insertAdjacentHTML(
      'beforeend',
      `<div class="stickerPrice">$${item.stickerTotal.toFixed(2)}</div>`,
    );
  }
};

/**
 * Parse sticker total price from item descriptions array.
 * Stickers are in descriptions with type "html" containing sticker images.
 * We look up each sticker name in priceEngine if available.
 */
export const parseStickerNames = (descriptions: any[] | undefined): string[] => {
  if (!descriptions) return [];
  const names: string[] = [];
  for (const desc of descriptions) {
    if (desc.type === 'html' && typeof desc.value === 'string' && desc.value.includes('sticker')) {
      // Extract sticker names from img alt attributes or title
      const matches = desc.value.match(/Sticker \| [^<"]+/g);
      if (matches) {
        for (const m of matches) {
          names.push(m.trim());
        }
      }
    }
  }
  return names;
};

/**
 * Resize the trade protection icon (provisional_item_badge) to not obstruct the item.
 * cs2trader EXACT: background-size: 20px, left: 4px, bottom: 59px
 */
export const resizeTradeProtectionIcon = (itemElement: HTMLElement | null): void => {
  if (!itemElement) return;
  const badge = itemElement.querySelector('div.provisional_item_badge') as HTMLElement | null;
  if (badge) {
    badge.style.backgroundSize = '20px';
    badge.style.left = '4px';
    badge.style.bottom = '59px';
  }
};

// ============================================================
// BUFF link helper (direct goods link, not search)
// ============================================================
import buffIds from './buffIds.json';

export const getBuffLink = (marketHashName: string, _dopplerPhase?: string): string => {
  // cs2trader pattern: direct goods link via buffIds, no phase filter
  // BUFF shows all phases on one page, user filters manually
  const buffId = (buffIds as Record<string, number>)[marketHashName];
  if (buffId) return `https://buff.163.com/goods/${buffId}`;
  return `https://buff.163.com/market/csgo#tab=selling&page_num=1&search=${encodeURIComponent(marketHashName)}`;
};

export const getCsFloatLink = (marketHashName: string, opts?: { defIndex?: number; paintIndex?: number; dopplerPhase?: string }): string => {
  // Best: def_index + paint_index (from protobuf decode) — exact CSFloat search
  if (opts?.defIndex && opts?.paintIndex) {
    return `https://csfloat.com/search?def_index=${opts.defIndex}&paint_index=${opts.paintIndex}`;
  }
  // Fallback: market_hash_name with [Phase X] suffix (csfloat-extension pattern)
  let mhn = marketHashName;
  if (opts?.dopplerPhase) {
    mhn += ` [${opts.dopplerPhase}]`;
  }
  return `https://csfloat.com/search?market_hash_name=${encodeURIComponent(mhn)}`;
};

// ============================================================
// Doppler phase detection + colors
// ============================================================

const DOPPLER_PHASES: Record<string, { short: string; color: string }> = {
  'Phase 1': { short: 'P1', color: '#2b1256' },
  'Phase 2': { short: 'P2', color: '#562430' },
  'Phase 3': { short: 'P3', color: '#092550' },
  'Phase 4': { short: 'P4', color: '#134d96' },
  'Sapphire': { short: 'SH', color: '#0000ff' },
  'Ruby': { short: 'RB', color: '#ff0000' },
  'Black Pearl': { short: 'BP', color: '#000000' },
  'Emerald': { short: 'EM', color: '#00ff00' },
};

/**
 * Detect doppler phase from item name or market_hash_name.
 * Returns { short, color } or null.
 */
export const getDopplerPhase = (name: string): { short: string; color: string } | null => {
  if (!name.toLowerCase().includes('doppler')) return null;
  for (const [phase, info] of Object.entries(DOPPLER_PHASES)) {
    if (name.includes(phase)) return info;
  }
  // Gamma doppler phases
  if (name.includes('Gamma') && name.includes('Phase')) {
    if (name.includes('Phase 1')) return { short: 'P1', color: '#126c49' };
    if (name.includes('Phase 2')) return { short: 'P2', color: '#5fe08f' };
    if (name.includes('Phase 3')) return { short: 'P3', color: '#36576d' };
    if (name.includes('Phase 4')) return { short: 'P4', color: '#0e766f' };
  }
  return { short: '?', color: '#333' };
};

/**
 * Add doppler phase indicator to item element.
 * Shows phase name (P1-P4, SH, RB, BP, EM) with colored text.
 */
export const addDopplerPhase = (
  itemElement: HTMLElement | null,
  iconUrl?: string,
): void => {
  if (!itemElement || !iconUrl) return;
  if (itemElement.querySelector('.dopplerPhase')) return;
  const phase = getDopplerInfoByIcon(iconUrl);
  if (!phase) return;

  const div = document.createElement('div');
  div.className = 'dopplerPhase';
  div.style.color = `#${phase.color}`;
  div.textContent = phase.short;
  itemElement.appendChild(div);
};

// ============================================================
// cs2trader: addFadePercentage / addPatternIndicator
// Shows fade %, marble fade pattern, case hardened blue % on item cards
// ============================================================

export const addPatternIndicator = (
  itemElement: HTMLElement | null,
  patternInfo: { type: string; value: string; short?: number | string } | null | undefined,
): void => {
  if (!itemElement || !patternInfo) return;
  if (itemElement.querySelector('.patternIndicator')) return;

  const div = document.createElement('div');

  if (patternInfo.type === 'fade') {
    div.className = 'patternIndicator fadePercentage';
    div.textContent = `${patternInfo.short}%`;
  } else if (patternInfo.type === 'marble_fade') {
    div.className = 'patternIndicator marbleFade';
    div.textContent = String(patternInfo.short || patternInfo.value);
  } else if (patternInfo.type === 'case_hardened') {
    div.className = 'patternIndicator caseHardened';
    div.textContent = String(patternInfo.value);
  } else {
    return;
  }

  itemElement.appendChild(div);
};

// ============================================================
// cs2trader EXACT: makeItemColorful — colored backgrounds by rarity
// ============================================================

/**
 * cs2trader EXACT: internal_name → quality_name → background color
 * From rarities.js + qualities.js
 */
const INTERNAL_NAME_TO_BG: Record<string, string> = {
  // Stock/Default
  'Rarity_Default': '#453b30',
  'Rarity_Default_Weapon': '#453b30',
  // Common (Consumer Grade / Base Grade)
  'Rarity_Common': '#7e7e7e',
  'Rarity_Common_Weapon': '#7e7e7e',
  // Uncommon (Industrial Grade / High Grade)
  'Rarity_Uncommon': '#3d6896',
  'Rarity_Uncommon_Weapon': '#3d6896',
  // Rare (Mil-Spec / Distinguished)
  'Rarity_Rare': '#414e9c',
  'Rarity_Rare_Weapon': '#414e9c',
  'Rarity_Rare_Character': '#414e9c',
  // Mythical (Restricted / Exceptional)
  'Rarity_Mythical': '#50248e',
  'Rarity_Mythical_Weapon': '#50248e',
  'Rarity_Mythical_Character': '#50248e',
  // Legendary (Classified / Superior)
  'Rarity_Legendary': '#6c297f',
  'Rarity_Legendary_Weapon': '#6c297f',
  'Rarity_Legendary_Character': '#6c297f',
  // Ancient (Covert / Master)
  'Rarity_Ancient': '#653232',
  'Rarity_Ancient_Weapon': '#653232',
  'Rarity_Ancient_Character': '#653232',
  // Contraband
  'Rarity_Contraband': '#b27d36',
  'Rarity_Contraband_Weapon': '#b27d36',
};

/**
 * Get background color from item tags.
 * cs2trader EXACT: looks for tag.category === 'Rarity', maps tag.internal_name
 */
export const getRarityBackgroundColor = (tags: any[] | undefined): string | null => {
  if (!tags) return null;
  for (const tag of tags) {
    if (tag.category === 'Rarity' && tag.internal_name) {
      return INTERNAL_NAME_TO_BG[tag.internal_name] || '#453b30';
    }
  }
  return null;
};

/**
 * cs2trader EXACT: makeItemColorful
 * Uses setAttribute('style', ...) to COMPLETELY override the item card style.
 * This overrides CSFloat and Steam defaults, making cards visually distinctive.
 *
 * cs2trader source (utilsModular.js line 671):
 *   itemElement.setAttribute('style', `background-image: url(); background-color: #${color}`);
 */
export const makeItemColorful = (
  itemElement: HTMLElement | null,
  tags: any[] | undefined,
  nameColor?: string,
  _itemName?: string,
  iconUrl?: string,
): void => {
  if (!itemElement) return;
  if (itemElement.getAttribute('data-colorful') === 'true') return;

  // cs2trader: doppler items get phase-specific background color via icon_url mapping
  if (iconUrl) {
    const dopplerInfo = getDopplerInfoByIcon(iconUrl);
    if (dopplerInfo) {
      itemElement.style.backgroundImage = 'url()';
      itemElement.style.backgroundColor = `#${dopplerInfo.color}`;
      if (!itemElement.classList.contains('activeInfo')) {
        itemElement.style.borderColor = `#${dopplerInfo.color}`;
      }
      itemElement.setAttribute('data-colorful', 'true');
      itemElement.setAttribute('data-doppler', dopplerInfo.short);
      return;
    }
  }

  const bgColor = getRarityBackgroundColor(tags);
  if (bgColor) {
    itemElement.style.backgroundImage = 'url()';
    itemElement.style.backgroundColor = bgColor;
    if (!itemElement.classList.contains('activeInfo')) {
      itemElement.style.borderColor = bgColor;
    }
  } else if (nameColor) {
    itemElement.style.backgroundImage = 'url()';
    if (!itemElement.classList.contains('activeInfo')) {
      itemElement.style.borderColor = `#${nameColor}`;
    }
  }
  itemElement.setAttribute('data-colorful', 'true');
};

// ============================================================
// Trade hold badge ("7d", "6d") — cs2trader .perItemDate
// ============================================================

/**
 * Parse tradability from item descriptions/owner_descriptions.
 * Returns { tradability, tradabilityShort, daysRemaining }
 */
export const parseTradability = (
  tradable: number,
  _descriptions: any[] | undefined,
  ownerDescriptions: any[] | undefined,
): { tradability: string; tradabilityShort: string; daysRemaining: number } => {
  // cs2trader EXACT: parse from owner_descriptions
  // Looks for "Tradable/Marketable After DATE" or "transferred until DATE"
  if (tradable === 0) {
    const ownerDescs = ownerDescriptions || [];
    for (const desc of ownerDescs) {
      const val = typeof desc === 'string' ? desc : desc?.value || '';
      if (!/\d/.test(val)) continue; // must contain a digit (date)
      try {
        let dateStr = '';
        if (val.includes('transferred until')) {
          dateStr = val.split('transferred until ')[1]?.replace(/[()]/g, '') || '';
        } else if (val.includes('Tradable') || val.includes('Marketable')) {
          // "Tradable/Marketable After Mar 31, 2026 (7:00:00) GMT"
          dateStr = val.split(/After\s+/)[1]?.replace(/[()]/g, '') || '';
        }
        if (dateStr) {
          const holdEnd = new Date(dateStr.trim());
          if (!isNaN(holdEnd.getTime())) {
            const now = new Date();
            const distance = holdEnd.getTime() - now.getTime();
            if (distance <= 0) {
              return { tradability: 'Tradable', tradabilityShort: 'T', daysRemaining: 0 };
            }
            // cs2trader getShortDate logic
            const days = Math.floor(distance / (1000 * 60 * 60 * 24));
            const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            let short = '';
            if (days > 0) short = `${days}d`;
            else if (hours > 0) short = `${hours}h`;
            else short = '<1h';
            return { tradability: dateStr, tradabilityShort: short, daysRemaining: days };
          }
        }
      } catch { /* ignore parse errors */ }
    }
    return { tradability: 'Tradelocked', tradabilityShort: 'L', daysRemaining: 0 };
  }
  return { tradability: 'Tradable', tradabilityShort: '', daysRemaining: 0 };
};

/**
 * Add trade hold badge ("7d") to item element — top-left.
 * cs2trader: .perItemDate positioned at top-left corner
 */
export const addTradeHoldBadge = (
  itemElement: HTMLElement | null,
  tradabilityShort: string,
): void => {
  if (!itemElement || !tradabilityShort) return;
  if (itemElement.querySelector('.perItemDate')) return;

  itemElement.insertAdjacentHTML(
    'beforeend',
    `<div class="perItemDate not_tradable">${tradabilityShort}</div>`,
  );
};
