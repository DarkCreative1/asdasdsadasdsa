# Proxy Pool

Node.js tabanlı proxy havuzu; HTTP, HTTPS, SOCKS4 ve SOCKS5 kaynaklarını toplar, Google `generate_204` ile kontrol eder ve yalnızca son kontrol penceresinde en az iki kontrolde %100 başarılı olan proxyleri yayınlar. Geçici olarak bozulan bir proxy iki yeni başarılı kontrolden sonra tekrar havuza girebilir; tek bir bozuk proxy hiçbir zaman tüm batch’i durdurmaz.

## Yerel çalıştırma

```bash
npm install
copy .env.example .env       # Windows
# cp .env.example .env       # Linux/macOS
npm start
# Panel doğrudan komut istiyorsa:
node /home/container/index.js
```

API: `http://localhost:8000/health`, `http://localhost:8000/proxies?limit=50` ve `http://localhost:8000/proxies.txt`.
Protokol listeleri: `/proxies/http`, `/proxies/https`, `/proxies/socks4`, `/proxies/socks5`.

Snapshot üretmek için:

```bash
node scripts/refresh_snapshot.js
```

Bu komut kaynakları yerel SQLite veritabanına yazar, iki kontrol turu yapar ve `data/proxies.txt` ile `data/proxies.json` dosyalarını günceller. `MAX_CANDIDATES_PER_CYCLE=0` tüm adayları test eder. Varsayılan kontrol timeout’u 2 saniyedir.

VPS çalışma varsayılanları dengeli tutulur: kaynak yenileme 300 saniye, tarama turu 10 saniye, bayatlık süresi 60 saniye ve 100 eşzamanlı proxy kontrolü. Uzun taramalar `CHECK_PERSIST_BATCH_SIZE` kadar parçalar halinde kaydedilir ve veritabanı dosyası atomik olarak değiştirilir; ani yeniden başlatma sırasında yarım SQLite dosyası bırakılmaz. Proxy havuzu her 10 saniyede yenilenirken kaynak listelerini her dakika tekrar çekmek public kaynaklarda rate-limit ve VPS bağlantı havuzu tükenmesine yol açabilir. `CHECK_CONCURRENCY` ve `SOURCE_FETCH_CONCURRENCY` değerlerini VPS kaynaklarına göre ayarlayabilirsiniz.

## Railway / VPS (saf Node.js)

Docker gerekli değildir. Node.js 24 veya daha yeni bir sürüm kurulu sistemde doğrudan çalışır:

```bash
git clone https://github.com/DarkCreative1/asdasdsadasdsa.git
cd asdasdsadasdsa
npm ci
cp .env.example .env
npm start
```

Windows’ta `.env` kopyalama komutu `copy .env.example .env` şeklindedir. Railway başlangıç komutu `npm start`, healthcheck yolu `/health` ve Node sürümü `24` olarak tanımlıdır. VPS’te SQLite kalıcılığı için `DATABASE_PATH` değerini kalıcı bir klasöre yönlendirin.

İsteğe bağlı olarak `npm start` komutunu systemd, PM2 veya Windows Görev Zamanlayıcı ile servis olarak çalıştırabilirsiniz; uygulamanın çalışması için Docker gerekmez.

VPS’te yalnızca izinli ve yasal trafik için kullanın. Public proxy listeleri hızlı değişir; snapshot dosyası anlık garanti vermez.

## Testler

Uzun çalışmada `ENOBUFS` / `EMFILE` gibi hatalar sunucunun ağ kaynaklarının
tükendiğini gösterir. `socket-lifecycle-v2` sürümü timeout iptalini hem HTTP
isteğine hem proxy bağlantısına iletir; SOCKS el sıkışmasına da aynı süre sınırı
uygular. Kaynak tükenmesi algılanırsa yeni taramalar 30–300 saniye duraklatılır,
eşzamanlılık azaltılır ve başarılı kontroller geldikçe yavaşça yükseltilir.
Bu sırada yerel kaynak hataları proxy başarısızlığı olarak kaydedilmez.
`STALE_AFTER_SECONDS` süresini geçen sonuçlar API'de stabil gösterilmez.

`/health` içindeki `runtime` alanı sürümü, uptime, RSS belleği, aktif Node kaynak
sayılarını, cooldown durumunu ve son turun hata dağılımını gösterir. Worker
logları aynı tanı bilgileriyle zaman damgası içerir. Windows'ta işletim sistemi
bağlantı durumlarını görmek için PowerShell'de `Get-NetTCPConnection |
Group-Object State | Select-Object Count,Name` kullanılabilir.

VDS güncellemesi: uygulamayı Ctrl+C ile kapatın, `.env` ve `data/proxies.db`
dosyalarını koruyarak güncel proje dosyalarını aktarın, `npm install` ve
`node index.js` çalıştırın. Git ile kurulduysa dosya aktarımı yerine
`git pull --ff-only origin main` kullanılabilir. Yeni kodun çalıştığını
`/health` → `runtime.version = socket-lifecycle-v2` alanından doğrulayın.

```bash
npm run check
npm test
node scripts/smoke_test.js 100
```

Unit testleri batch izolasyonunu, bozuk SOCKS proxylerini, timeout davranışını, kaynak ayrıştırmayı, iki başarılı kontrol şartını ve geçici hatadan sonra havuza geri dönüşü doğrular.

TCP testleri, bağlantıyı kabul edip el sıkışmasına cevap vermeyen yerel
sunucularda her turdan sonra açık soket sayısının sıfıra döndüğünü doğrular.
PowerShell'de daha uzun tekrar testi: `$env:NETWORK_TEST_WAVES=100` ardından
`node --test test/network.test.js`. Bu gerçek TCP bağlantı testi, 24/90 saatlik
kesintisiz VDS çalışmasının yerine geçmez; eski 5.400 sonuç testi yalnızca
veritabanı sayaçlarını sınar.

## GitHub Actions

`CI` workflow’u Node 24 ile syntax ve unit testlerini çalıştırır. `Proxy pool refresh` workflow’u beş dakikada bir kaynakları çekip iki kontrol turu yapar, snapshot’ı commitler ve pushlar. Repo ayarlarında Actions için `Read and write permissions` açık olmalıdır.
