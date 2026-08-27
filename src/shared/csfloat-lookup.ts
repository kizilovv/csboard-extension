// ============================================================
// CSBOARD — Canonical CSFloat search URL builder
// ============================================================
// Keep this module pure: it is used by content scripts and contract tests and
// must not depend on DOM or chrome.* APIs.

export type CsfloatWear =
  | 'Factory New'
  | 'Minimal Wear'
  | 'Field-Tested'
  | 'Well-Worn'
  | 'Battle-Scarred';

export interface CsfloatSteamTag {
  category?: string;
  category_name?: string;
  internal_name?: string;
  localized_category_name?: string;
  localized_tag_name?: string;
  name?: string;
}

export interface CsfloatLookupItem {
  assetId?: string;
  marketHashName: string;
  defIndex?: number | null;
  paintIndex?: number | null;
  paintSeed?: number | null;
  floatValue?: number | null;
  dopplerPhase?: string | null;
  isStatTrak?: boolean;
  isSouvenir?: boolean;
  isKnife?: boolean;
  isGlove?: boolean;
  wear?: CsfloatWear | null;
  itemType?: string | null;
  tags?: readonly CsfloatSteamTag[] | null;
}

export interface CsfloatLookupOptions {
  mode?: 'comparable' | 'generic';
  dynamicFloatForGloves?: boolean;
}

interface WearRange {
  min: number;
  max: number;
}

const CSFLOAT_SEARCH_URL = 'https://csfloat.com/search';

const WEAR_RANGES: Readonly<Record<CsfloatWear, WearRange>> = {
  'Factory New': { min: 0, max: 0.07 },
  'Minimal Wear': { min: 0.07, max: 0.15 },
  'Field-Tested': { min: 0.15, max: 0.38 },
  'Well-Worn': { min: 0.38, max: 0.45 },
  'Battle-Scarred': { min: 0.45, max: 1 },
};

const WEARS = Object.keys(WEAR_RANGES) as CsfloatWear[];

const isPositiveIndex = (value: number | null | undefined): value is number =>
  Number.isInteger(value) && Number(value) > 0;

const isWear = (value: unknown): value is CsfloatWear =>
  typeof value === 'string' && WEARS.includes(value as CsfloatWear);

const tagText = (tag: CsfloatSteamTag): string =>
  [
    tag.category,
    tag.category_name,
    tag.internal_name,
    tag.localized_category_name,
    tag.localized_tag_name,
    tag.name,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');

const parseWear = (item: CsfloatLookupItem): CsfloatWear | null => {
  if (isWear(item.wear)) return item.wear;

  const nameMatch = item.marketHashName.match(
    /\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)\s*$/,
  );
  if (nameMatch?.[1] && isWear(nameMatch[1])) return nameMatch[1];

  for (const tag of item.tags ?? []) {
    const text = tagText(tag);
    const wear = WEARS.find((candidate) => text.includes(candidate));
    if (wear) return wear;
  }

  return null;
};

const classifyItem = (item: CsfloatLookupItem, wear: CsfloatWear | null) => {
  const name = item.marketHashName.trim();
  const typeText = [item.itemType ?? '', ...(item.tags ?? []).map(tagText)].join(' ');

  const isGlove =
    item.isGlove === true ||
    /\bgloves?\b|\bhand wraps?\b/i.test(typeText) ||
    /\bgloves?\b|\bhand wraps?\b/i.test(name);

  const isKnife =
    item.isKnife === true ||
    /\bknife\b|\bbayonet\b/i.test(typeText) ||
    (/^★(?:\s+StatTrak™?)?\s+/u.test(name) && !isGlove);

  const hasPaintIdentity = isPositiveIndex(item.defIndex) && isPositiveIndex(item.paintIndex);
  const isPainted = wear !== null || hasPaintIdentity || isKnife || isGlove;

  const isSouvenir = item.isSouvenir === true || /\bSouvenir\b/i.test(name);
  const isStatTrak = item.isStatTrak === true || /\bStatTrak(?:™)?(?=\s|$)/i.test(name);

  return { hasPaintIdentity, isGlove, isKnife, isPainted, isSouvenir, isStatTrak };
};

const decimalString = (value: number): string => {
  if (value === 0 || value === 1) return String(value);
  return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
};

const withDopplerPhase = (marketHashName: string, dopplerPhase?: string | null): string => {
  const name = marketHashName.trim();
  const phase = dopplerPhase?.trim().replace(/\s+/g, ' ');
  if (!phase) return name;

  const lowerName = name.toLocaleLowerCase('en-US');
  const lowerPhase = phase.toLocaleLowerCase('en-US');
  if (lowerName.includes(`[${lowerPhase}]`) || lowerName.includes(lowerPhase)) return name;

  return `${name} [${phase}]`;
};

/**
 * Build the one canonical CSFloat search URL used by every extension surface.
 *
 * Comparable searches always use the lowest buy-now price. A valid def/paint
 * pair is preferred as identity; otherwise the canonical market name is kept
 * as an explicit, non-exact fallback. Float narrowing beyond the wear band is
 * deliberately limited to GLOVES — see `canNarrow` for why knives lost it.
 */
export const buildCsfloatSearchUrl = (
  item: CsfloatLookupItem,
  options: CsfloatLookupOptions = {},
): string => {
  const mode = options.mode ?? 'comparable';
  const url = new URL(CSFLOAT_SEARCH_URL);
  const wear = parseWear(item);
  const classification = classifyItem(item, wear);

  if (mode === 'comparable') {
    if (classification.isPainted) {
      const category = classification.isSouvenir
        ? 3
        : classification.isStatTrak
          ? 2
          : 1;
      url.searchParams.set('category', String(category));
    }

    url.searchParams.set('sort_by', 'lowest_price');

    if (wear) {
      const range = WEAR_RANGES[wear];
      let maxFloat = range.max;
      const floatValue = item.floatValue;
      /*
        Gloves only. Knives used to be narrowed the same way and it did more
        harm than good: a knife's price is driven by pattern and by the wear
        band, not by the third decimal, so clamping the search to your own float
        hid most of the comparable market and left the "lowest price" reading
        off a handful of listings. Gloves keep it because their float genuinely
        moves the price inside a single wear band.
      */
      const canNarrow =
        options.dynamicFloatForGloves !== false &&
        classification.isGlove &&
        typeof floatValue === 'number' &&
        Number.isFinite(floatValue) &&
        floatValue >= range.min &&
        floatValue <= range.max;

      if (canNarrow) {
        const roundedUp = Math.ceil(floatValue * 100) / 100;
        maxFloat = Math.min(range.max, roundedUp);
        if (maxFloat <= range.min) {
          maxFloat = Math.min(range.max, range.min + 0.01);
        }
      }

      url.searchParams.set('min_float', decimalString(range.min));
      url.searchParams.set('max_float', decimalString(maxFloat));
    }

    url.searchParams.set('type', 'buy_now');

    if (classification.hasPaintIdentity) {
      url.searchParams.set('def_index', String(item.defIndex));
      url.searchParams.set('paint_index', String(item.paintIndex));
    } else {
      const fallbackName = withDopplerPhase(item.marketHashName, item.dopplerPhase);
      if (fallbackName) url.searchParams.set('market_hash_name', fallbackName);
    }
  } else {
    const fallbackName = withDopplerPhase(item.marketHashName, item.dopplerPhase);
    if (fallbackName) url.searchParams.set('market_hash_name', fallbackName);
  }

  return url.toString();
};
