const numericAssetId = (value: unknown): string | undefined => {
  const normalized = typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '';
  return /^\d{1,32}$/.test(normalized) ? normalized : undefined;
};

export const assetIdFromInspectHref = (href: string | undefined): string | undefined => {
  if (!href) return undefined;
  let normalizedHref = href;
  try {
    normalizedHref = decodeURIComponent(href);
  } catch {
    // Steam/third-party hrefs can be malformed. The selected DOM item remains
    // a safe fallback, so a decode failure must not break marketplace links.
  }
  return numericAssetId(normalizedHref.match(/A(\d+)D/i)?.[1]);
};

export const assetIdFromInventoryElementId = (elementId: string | undefined): string | undefined => {
  if (!elementId) return undefined;
  const match = /^730_\d{1,16}_(\d{1,32})$/.exec(elementId);
  return numericAssetId(match?.[1]);
};

export const resolveInventoryLookupItem = (
  items: readonly any[],
  itemName: string,
  inspectHref?: string,
  activeInventoryElementId?: string,
): any | undefined => {
  const assetId = assetIdFromInspectHref(inspectHref)
    ?? assetIdFromInventoryElementId(activeInventoryElementId);

  if (assetId) {
    const exact = items.find((candidate) => numericAssetId(candidate?.assetid) === assetId);
    if (exact) return exact;
  }

  const nameMatches = items.filter(
    (candidate) => candidate?.market_hash_name === itemName || candidate?.name === itemName,
  );
  return nameMatches.length === 1 ? nameMatches[0] : undefined;
};
