export function createRetryingLazyPromise<T>(
  factory: () => Promise<T>,
): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= factory().catch((error) => {
      pending = null;
      throw error;
    });
    return pending;
  };
}
