export function createHttpWakeDeliverer(url, fetchFn = fetch) {
  if (!url) return null;

  return async (envelope) => {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(envelope),
    });

    if (!response.ok) {
      throw new Error(`Runtime wake callback failed with HTTP ${response.status}`);
    }

    let body = {};
    try {
      body = await response.json();
    } catch {
      // A 2xx response without JSON is still a valid acceptance.
    }

    return {
      runtimeReceiptId:
        typeof body.runtimeReceiptId === 'string'
          ? body.runtimeReceiptId
          : undefined,
    };
  };
}
