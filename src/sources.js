import axios from 'axios';
import { setTimeout as delay } from 'node:timers/promises';
import { settings } from './config.js';
import { errorCode, isResourceError, networkGuard } from './network.js';

export const SOURCES = [
  ['proxyscrape-socks5-fast', 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=displayproxies&protocol=socks5&timeout=1000&country=all&ssl=all&anonymity=all', 'socks5'],
  ['proxyscrape-http-fast', 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=displayproxies&protocol=http&timeout=1000&country=all&ssl=all&anonymity=all', 'http'],
  ['geonode-socks5', 'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&protocols=socks5', 'socks5'],
  ['proxifly-http', 'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/http/data.txt', 'http'],
  ['proxifly-https', 'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/https/data.txt', 'https'],
  ['proxifly-socks4', 'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/socks4/data.txt', 'socks4'],
  ['proxifly-socks5', 'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/socks5/data.txt', 'socks5'],
  ['iplocate-http', 'https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/http.txt', 'http'],
  ['iplocate-https', 'https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/https.txt', 'https'],
  ['iplocate-socks4', 'https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/socks4.txt', 'socks4'],
  ['iplocate-socks5', 'https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/socks5.txt', 'socks5'],
  ['thespeedx-http', 'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt', 'http'],
  ['thespeedx-socks4', 'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks4.txt', 'socks4'],
  ['thespeedx-socks5', 'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks5.txt', 'socks5'],
  ['monosans-http', 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt', 'http'],
  ['monosans-socks4', 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt', 'socks4'],
  ['monosans-socks5', 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt', 'socks5'],
];

export function parseSourceText(source, text) {
  const found = new Set();
  try {
    const payload = JSON.parse(text);
    const rows = Array.isArray(payload) ? payload : payload?.data;
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (row?.ip && row?.port) found.add(`${source[2]}://${row.ip}:${row.port}`);
      }
      if (found.size) return found;
    }
  } catch {}

  for (const line of text.split(/\r?\n/)) {
    let value = line.trim();
    if (!value) continue;
    if (value.includes('://')) value = value.split('://', 2)[1];
    const match = value.match(/^([^:\s]+):(\d{1,5})$/);
    if (match && Number(match[2]) >= 1 && Number(match[2]) <= 65535) found.add(`${source[2]}://${match[1]}:${match[2]}`);
  }
  return found;
}

export async function fetchSource(source, client = axios, { signal } = {}) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    signal?.throwIfAborted();
    if (networkGuard.paused()) throw Object.assign(new Error('Local network cooldown'), { code: 'NETWORK_COOLDOWN' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await client.get(source[1], { signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, timeout: 15000, maxContentLength: 10 * 1024 * 1024, responseType: 'text' });
      return parseSourceText(source, response.data);
    } catch (error) {
      lastError = error;
      signal?.throwIfAborted();
      const code = errorCode(error);
      networkGuard.fail(code, settings.checkConcurrency);
      if (isResourceError(code)) throw error;
      if (attempt === 0) await delay(500, undefined, { signal });
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  throw lastError;
}

export async function fetchAllSources({ signal } = {}) {
  const results = new Array(SOURCES.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= SOURCES.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await fetchSource(SOURCES[index], axios, { signal }) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(settings.sourceFetchConcurrency, SOURCES.length) }, worker));
  return results.map((result, index) => ({ source: SOURCES[index], result }));
}
