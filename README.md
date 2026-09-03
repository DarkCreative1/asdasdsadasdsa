# Proxy Pool

Node.js tabanlı proxy havuzu; HTTP, HTTPS, SOCKS4 ve SOCKS5 kaynaklarını toplar, Google `generate_204` ile kontrol eder ve yalnızca en az iki kontrolde %100 başarılı olan proxyleri yayınlar. Bozuk bir proxy hiçbir zaman tüm batch’i durdurmaz.

## Yerel çalıştırma

```bash
npm install
copy .env.example .env       # Windows
# cp .env.example .env       # Linux/macOS
npm start
```

API: `http://localhost:8000/health`, `http://localhost:8000/proxies?limit=50` ve `http://localhost:8000/proxies.txt`.
Protokol listeleri: `/proxies/http`, `/proxies/https`, `/proxies/socks4`, `/proxies/socks5`.

Snapshot üretmek için:

```bash
node scripts/refresh_snapshot.js
```

Bu komut kaynakları yerel SQLite veritabanına yazar, iki kontrol turu yapar ve `data/proxies.txt` ile `data/proxies.json` dosyalarını günceller. `MAX_CANDIDATES_PER_CYCLE=0` tüm adayları test eder. Varsayılan kontrol timeout’u 2 saniyedir.

## Railway / Docker / VPS

Railway için başlangıç komutu `npm start`, healthcheck yolu `/health` ve Node sürümü `24` olarak tanımlıdır. SQLite kalıcılığı için `/data` volume’u bağlayıp `DATABASE_PATH=/data/proxies.db` kullanın.

```bash
docker compose up -d --build
```

VPS’te yalnızca izinli ve yasal trafik için kullanın. Public proxy listeleri hızlı değişir; snapshot dosyası anlık garanti vermez.

## Testler

```bash
npm run check
npm test
node scripts/smoke_test.js 100
```

Unit testleri batch izolasyonunu, bozuk SOCKS proxylerini, timeout davranışını, kaynak ayrıştırmayı ve iki başarılı kontrol şartını doğrular.

## GitHub Actions

`CI` workflow’u Node 24 ile syntax ve unit testlerini çalıştırır. `Proxy pool refresh` workflow’u beş dakikada bir kaynakları çekip iki kontrol turu yapar, snapshot’ı commitler ve pushlar. Repo ayarlarında Actions için `Read and write permissions` açık olmalıdır.
