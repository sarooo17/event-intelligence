import { timingSafeEqual } from 'node:crypto';

export class ValidationConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationConfigError';
    this.code = 'EI_VALIDATION_CONFIG_INVALID';
  }
}

export function requiredEnv(env, key, { minLength = 1 } = {}) {
  const value = env[key];
  if (typeof value !== 'string' || value.trim().length < minLength) {
    throw new ValidationConfigError(`${key} is required`);
  }
  return value.trim();
}

export function httpPort(env = process.env) {
  const raw = env.PORT ?? '3000';
  if (!/^[1-9]\d{0,4}$/.test(raw) || Number(raw) > 65535) {
    throw new ValidationConfigError('PORT must be an integer from 1 to 65535');
  }
  return Number(raw);
}

// Railway's *.railway.internal private service DNS uses IPv6. An IPv4-only
// 0.0.0.0 listener passes local and public health checks yet refuses requests
// from other services on the private IPv6 network. Dual-stack is deliberate.
export async function listenValidationPrivateServer(server, port) {
  if (!server || typeof server.listen !== 'function') throw new TypeError('server required');
  await new Promise((resolve, reject) => {
    const failed = error => {
      server.off('listening', ready);
      reject(error);
    };
    const ready = () => {
      server.off('error', failed);
      resolve();
    };
    server.once('error', failed);
    server.once('listening', ready);
    server.listen({ port, host: '::', ipv6Only: false });
  });
  return server;
}

export function safeIdentifier(value, label) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(value)) {
    throw new ValidationConfigError(`${label} has an invalid format`);
  }
  return value;
}

export function bearerMatches(request, token) {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export async function readJson(request, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('Request body exceeds the configured limit');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Request body must be valid JSON');
    error.statusCode = 400;
    throw error;
  }
}

export function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

export function safeError(error) {
  const message = String(error?.message ?? error)
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, 'postgresql://[redacted]')
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[redacted]')
    .slice(0, 300);
  return { code: String(error?.code ?? 'EI_VALIDATION_ERROR').slice(0, 80), message };
}

export function parsePrivateServiceUrl(raw, label, { allowLocal = false } = {}) {
  let url;
  try { url = new URL(raw); } catch { throw new ValidationConfigError(`${label} must be an HTTP URL`); }
  const local = allowLocal && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'http:' || (!url.hostname.endsWith('.railway.internal') && !local)) {
    throw new ValidationConfigError(`${label} must use Railway private HTTP networking`);
  }
  return url.toString().replace(/\/$/, '');
}

export function percentileStats(samples) {
  if (!Array.isArray(samples) || samples.length === 0 ||
      samples.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    throw new TypeError('latency samples must be a non-empty array of finite non-negative numbers');
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const at = p => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
  return { samples: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), maxMs: sorted.at(-1) };
}

export function monotonicMs(start, end) {
  const duration = Number(end - start) / 1e6;
  if (!Number.isFinite(duration) || duration < 0) throw new Error('monotonic clock interval is invalid');
  return duration;
}
