/**
 * Version-fenced wake delivery writes. A worker ID alone is insufficient:
 * the same worker can reclaim an expired delivery while a previous attempt
 * is still in flight (ABA). The durable claim's monotonically increasing
 * attemptCount is the fencing generation for that specific wake.
 */
export function assertWakeClaimGeneration(record, {
  workerId, attemptCount, wakeId, allowDelivered = false,
} = {}) {
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 1) {
    const error = new Error('Wake delivery requires a claim attemptCount');
    error.code = 'WAKE_DELIVERY_CLAIM_GENERATION_REQUIRED';
    throw error;
  }
  const generationMatches = record?.attemptCount === attemptCount;
  if (allowDelivered && record?.status === 'delivered' && generationMatches) {
    return true; // Same-generation, completed receipt is idempotent.
  }
  if (!generationMatches || record?.status !== 'claimed' ||
      record.leaseOwner !== String(workerId || '')) {
    const error = new Error(
      'Wake delivery ' + String(wakeId) + ' claim generation is no longer current',
    );
    error.code = 'WAKE_DELIVERY_CLAIM_LOST';
    throw error;
  }
  return true;
}
