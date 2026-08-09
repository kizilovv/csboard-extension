import type { P2PEligibleAsset } from './contracts';

export interface P2PAssetOptionModel {
  readonly value: string;
  readonly label: string;
}

export function buildP2PAssetOption(asset: P2PEligibleAsset): P2PAssetOptionModel {
  const listed = asset.listingId !== null && asset.listingState === 'active';
  const prefix = listed ? '[Listed] ' : asset.eligibility ? '' : '[Blocked] ';
  return {
    value: asset.operationalAssetId,
    label: `${prefix}${asset.marketHashName}`,
  };
}

export function p2pAssetOptionsMatch(
  current: readonly P2PAssetOptionModel[],
  desired: readonly P2PAssetOptionModel[],
): boolean {
  return current.length === desired.length && desired.every((option, index) =>
    current[index]?.value === option.value && current[index]?.label === option.label);
}
