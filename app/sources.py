from dataclasses import dataclass
import json
import re
import httpx


@dataclass(frozen=True)
class Source:
    name: str
    url: str
    protocol: str


SOURCES = [
    Source("proxyscrape-socks5-fast", "https://api.proxyscrape.com/v4/free-proxy-list/get?request=displayproxies&protocol=socks5&timeout=1000&country=all&ssl=all&anonymity=all", "socks5"),
    Source("proxyscrape-http-fast", "https://api.proxyscrape.com/v4/free-proxy-list/get?request=displayproxies&protocol=http&timeout=1000&country=all&ssl=all&anonymity=all", "http"),
    Source("proxy-list-download-socks5", "https://www.proxy-list.download/api/v1/get?type=socks5", "socks5"),
    Source("proxy-list-download-http", "https://www.proxy-list.download/api/v1/get?type=http", "http"),
    Source("geonode-socks5", "https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&protocols=socks5", "socks5"),
    # Independently maintained, frequently refreshed public snapshots.
    Source("proxifly-http", "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/http/data.txt", "http"),
    Source("proxifly-https", "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/https/data.txt", "https"),
    Source("proxifly-socks4", "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/socks4/data.txt", "socks4"),
    Source("proxifly-socks5", "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/socks5/data.txt", "socks5"),
    Source("iplocate-http", "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/http.txt", "http"),
    Source("iplocate-https", "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/https.txt", "https"),
    Source("iplocate-socks4", "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/socks4.txt", "socks4"),
    Source("iplocate-socks5", "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/socks5.txt", "socks5"),
    Source("jetkai-all", "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies.txt", "http"),
]


async def fetch_source(source: Source) -> set[str]:
    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        response = await client.get(source.url)
        response.raise_for_status()
        text = response.text
    found = set()
    # GeoNode and similar APIs return JSON; plain-list sources return one host:port per line.
    try:
        payload = json.loads(text)
        rows = payload.get("data", payload) if isinstance(payload, dict) else payload
        for row in rows if isinstance(rows, list) else []:
            if isinstance(row, dict) and row.get("ip") and row.get("port"):
                found.add(f"{source.protocol}://{row['ip']}:{row['port']}")
        if found:
            return found
    except (ValueError, TypeError):
        pass
    for line in text.splitlines():
        value = line.strip()
        if value and re.fullmatch(r"[^:\s]+:\d{1,5}", value):
            host, port = value.rsplit(":", 1)
            if host and port.isdigit() and 1 <= int(port) <= 65535:
                found.add(f"{source.protocol}://{host}:{port}")
    return found
