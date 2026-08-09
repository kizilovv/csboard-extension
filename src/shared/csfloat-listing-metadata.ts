export interface CsfloatListingMetadataText {
  readonly label: string;
  readonly title: string;
}

export interface CsfloatListingMetadataView {
  readonly listed: CsfloatListingMetadataText | null;
  readonly sold: CsfloatListingMetadataText | null;
}

interface BuildListingMetadataViewInput {
  readonly createdAt?: unknown;
  readonly soldAt?: unknown;
  readonly state?: string;
  readonly detail: boolean;
  readonly nowMs?: number;
}

export function parseCsfloatTimestamp(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function formatCsfloatRelativeTime(date: Date, nowMs = Date.now()): string {
  const diffMs = Math.max(0, nowMs - date.getTime());
  const minutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (hours >= 49) return `${days}d ago`;
  if (minutes >= 120) return `${hours}h ago`;
  return `${minutes}min ago`;
}

function formatFullTimestamp(date: Date): string {
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function buildListingMetadataView(
  input: BuildListingMetadataViewInput,
): CsfloatListingMetadataView {
  const listedAt = parseCsfloatTimestamp(input.createdAt);
  const soldAt = input.state === 'sold'
    ? parseCsfloatTimestamp(input.soldAt)
    : null;
  const nowMs = input.nowMs ?? Date.now();

  const listed = listedAt
    ? {
        label: input.detail
          ? `Listed ${formatCsfloatRelativeTime(listedAt, nowMs)}`
          : formatCsfloatRelativeTime(listedAt, nowMs),
        title: `Listed at ${formatFullTimestamp(listedAt)}`,
      }
    : null;
  const sold = soldAt
    ? {
        label: `Sold ${formatCsfloatRelativeTime(soldAt, nowMs)} (${formatFullTimestamp(soldAt)})`,
        title: `Sold at ${formatFullTimestamp(soldAt)}`,
      }
    : null;

  return { listed, sold };
}
