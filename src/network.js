// These describe the checking host, not the remote proxy's health.
const resourceCodes = ['ENOBUFS', 'EMFILE', 'ENFILE', 'ENOMEM', 'EADDRNOTAVAIL'];

export function errorCode(error) {
  const seen = new Set();
  let fallback;
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current);
    fallback ||= current.code;
    // SOCKS wraps the original socket error in its message and loses .code.
    const local = resourceCodes.find((code) => current.code === code ||
      new RegExp(`\\b${code}\\b`).test(current.message || ''));
    if (local) return local;
  }
  if (fallback) return fallback;
  const message = String(error?.message || '');
  const socketCode = message.match(/\b(E[A-Z0-9_]{3,})\b/);
  if (socketCode) return socketCode[1];
  if (/timed?\s*out|timeout/i.test(message)) return 'TimeoutError';
  if (/ended before receiving CONNECT/i.test(message)) return 'CONNECT_CLOSED';
  if (/socket closed/i.test(message)) return 'PROXY_SOCKET_CLOSED';
  if (/socks.*reject|no accepted auth/i.test(message)) return 'SOCKS_REJECTED';
  if (/invalid.*socks|socks.*invalid/i.test(message)) return 'SOCKS_PROTOCOL_ERROR';
  return error?.name || 'Error';
}

export function errorDetail(error) {
  return String(error?.message || error || 'Unknown failure')
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, '[url]')
    .replace(/[\r\n\t]/g, ' ').slice(0, 160);
}

export function isResourceError(code) {
  return resourceCodes.includes(code);
}

export class NetworkGuard {
  constructor(now = Date.now) {
    this.now = now;
    this.until = 0;
    this.strikes = 0;
    this.lastError = null;
    this.limit = null;
  }

  paused() { return this.now() < this.until; }

  fail(code, configuredLimit) {
    if (!isResourceError(code)) return;
    if (!this.paused()) {
      this.strikes++;
      this.limit = Math.max(1, Math.floor((this.limit ?? configuredLimit) / 2));
      this.until = this.now() + Math.min(300000, 30000 * 2 ** Math.min(this.strikes - 1, 4));
    }
    this.lastError = code;
  }

  concurrency(configuredLimit) { return Math.min(configuredLimit, this.limit ?? configuredLimit); }

  succeeded(configuredLimit) {
    if (!this.paused() && this.limit !== null) {
      this.limit = Math.min(configuredLimit, this.limit + 1);
      if (this.limit === configuredLimit) { this.limit = null; this.strikes = 0; }
    }
  }

  status(configuredLimit) {
    return { paused: this.paused(), retry_in_seconds: Math.max(0, Math.ceil((this.until - this.now()) / 1000)),
      check_concurrency: this.concurrency(configuredLimit), last_resource_error: this.lastError };
  }
}

export const networkGuard = new NetworkGuard();
