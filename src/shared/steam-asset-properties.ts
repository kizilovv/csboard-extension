import { decodeHex } from '@csfloat/cs2-inspect-serializer';

export interface ParsedSteamAssetProperties {
  readonly floatValue: number | undefined;
  readonly paintSeed: number | undefined;
  readonly defIndex: number | undefined;
  readonly paintIndex: number | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function propertyRecords(value: unknown, depth = 0): readonly Record<string, unknown>[] {
  if (depth > 3) return [];
  if (isRecord(value) &&
      value['asset_properties'] !== undefined &&
      value['propertyid'] === undefined &&
      value['def_index'] === undefined) {
    return propertyRecords(value['asset_properties'], depth + 1);
  }

  const values = Array.isArray(value)
    ? value
    : isRecord(value)
      ? Object.values(value)
      : [];
  const records: Record<string, unknown>[] = [];

  for (const entry of values) {
    if (!isRecord(entry)) continue;
    if (entry['asset_properties'] !== undefined &&
        entry['propertyid'] === undefined &&
        entry['def_index'] === undefined) {
      records.push(...propertyRecords(entry['asset_properties'], depth + 1));
    } else {
      records.push(entry);
    }
  }

  return records;
}

function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const numeric = finiteNumber(value);
  return numeric !== undefined && Number.isSafeInteger(numeric) && numeric >= 0
    ? numeric
    : undefined;
}

function boundedFloat(value: unknown): number | undefined {
  const numeric = finiteNumber(value);
  return numeric !== undefined && numeric >= 0 && numeric <= 1 ? numeric : undefined;
}

/**
 * Normalizes Steam's CS2 asset metadata.
 *
 * Steam may expose paint metadata as direct properties (1 = seed, 2 = float)
 * or only inside property 6's inspect certificate. Trade-offer inventories use
 * both array and object-map shapes, so callers must not assume either one.
 */
export function parseSteamAssetProperties(value: unknown): ParsedSteamAssetProperties {
  let floatValue: number | undefined;
  let paintSeed: number | undefined;
  let defIndex: number | undefined;
  let paintIndex: number | undefined;
  const certificates: string[] = [];

  for (const property of propertyRecords(value)) {
    const propertyId = nonNegativeInteger(property['propertyid'] ?? property['def_index']);
    if (propertyId === 1 && paintSeed === undefined) {
      paintSeed = nonNegativeInteger(property['int_value'] ?? property['value']);
    }
    if (propertyId === 2 && floatValue === undefined) {
      floatValue = boundedFloat(property['float_value'] ?? property['value']);
    }
    if (propertyId === 6) {
      const certificate = property['string_value'] ?? property['value'];
      if (typeof certificate === 'string' && certificate.length <= 16_384) {
        certificates.push(certificate);
      }
    }
  }

  for (const certificate of certificates) {
    try {
      const decoded = decodeHex(certificate);
      floatValue ??= boundedFloat(decoded.paintwear);
      paintSeed ??= nonNegativeInteger(decoded.paintseed);
      defIndex ??= nonNegativeInteger(decoded.defindex);
      paintIndex ??= nonNegativeInteger(decoded.paintindex);
    } catch {
      // Steam-owned metadata can be absent or malformed; enrichment is best-effort.
    }
  }

  return { floatValue, paintSeed, defIndex, paintIndex };
}
