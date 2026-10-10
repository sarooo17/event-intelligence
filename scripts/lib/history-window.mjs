/** Shared bounded history-window contract for JSONL and PostgreSQL stores. */
export function validateHistoryWindowLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    const error = new RangeError('History window limit must be an integer from 1 to 500');
    error.code = 'EVENT_INTELLIGENCE_HISTORY_LIMIT_INVALID';
    throw error;
  }
  return limit;
}
