const CS2_INSPECT_LINK_RE =
  /^steam:\/\/(?:rungame|run)\/730\/[^/\s]*\/\+csgo_econ_action_preview(?:%20| )(?:[SM]\d+A\d+D\d+|[0-9A-Fa-f]{16,900})$/;

const ACCESSORY_NAME_RE =
  /(?:^|\s)((?:Sticker|Patch|Charm)\s*\|\s*.+?)(?=\s*(?:Sticker\s+Scrape\s+Level|Scrape\s+Level|Wear\s*:|$))/i;

export interface AccessoryPrice {
  readonly display: string;
}

export type AccessoryPriceLookup = (marketHashName: string) => AccessoryPrice | null;

/**
 * CSFolder direct renders keep the complete Steam action in one encoded route
 * segment. The server owns decoding and shape validation again before a paid
 * cache miss, while an invalid third-party href never becomes a clickable
 * screenshot action in the first place.
 */
export function buildCsfolderInspectUrl(
  inspectLink: string,
  locale: 'en' | 'ru' = 'ru',
): string | null {
  const normalized = inspectLink.trim();
  if (!CS2_INSPECT_LINK_RE.test(normalized)) return null;
  const prefix = locale === 'ru' ? '/ru' : '';
  return `https://csfolder.com${prefix}/inspect/${encodeURIComponent(normalized)}`;
}

/**
 * Keep exactly one CSFolder action beside Steam's native Inspect in Game link.
 * Steam mutates the inventory panel frequently, so an existing button is
 * updated in place instead of being removed and recreated on every observer
 * pass (which is visible as flicker).
 */
export function upsertCsfolderScreenshotAction(
  inspectLink: HTMLAnchorElement,
  screenshotHref: string | null,
): HTMLAnchorElement | null {
  const sibling = inspectLink.nextElementSibling;
  const existing = sibling?.classList.contains('csboard-screenshot-inline')
    ? sibling as HTMLAnchorElement
    : null;

  if (!screenshotHref) {
    existing?.remove();
    return null;
  }

  const action = existing ?? inspectLink.ownerDocument.createElement('a');
  action.classList.add('csboard-screenshot-action', 'csboard-screenshot-inline');
  action.href = screenshotHref;
  action.target = '_blank';
  action.rel = 'noopener noreferrer';
  action.textContent = 'Get screenshot';
  action.title = 'Render this item on CSFolder';

  if (!existing) inspectLink.insertAdjacentElement('afterend', action);
  return action;
}

/** Pull the first marketable accessory name out of Steam's native row text. */
export function canonicalAccessoryMarketName(text: string): string | null {
  const normalized = text.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
  const match = ACCESSORY_NAME_RE.exec(normalized);
  return match?.[1]?.replace(/\s+/g, ' ').trim() || null;
}

function directText(element: Element): string {
  return Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? '')
    .join(' ')
    .trim();
}

/**
 * Add the selected price source beside each native Accessories title. Steam
 * owns the row and its scrape/wear line; CSBOARD only appends a small price
 * badge and can safely rerun after every popup redraw.
 */
export function decorateAccessoryPrices(
  root: ParentNode,
  lookup: AccessoryPriceLookup,
): number {
  let decorated = 0;
  root.querySelectorAll<HTMLElement>('div, span, p').forEach((element) => {
    if (element.querySelector(':scope > .csboard-accessory-price')) return;
    const name = canonicalAccessoryMarketName(directText(element));
    if (!name) return;
    const price = lookup(name);
    if (!price) return;

    const badge = document.createElement('span');
    badge.className = 'csboard-accessory-price';
    badge.textContent = price.display;
    badge.title = `${name}: ${price.display}`;
    element.appendChild(badge);
    decorated += 1;
  });
  return decorated;
}
