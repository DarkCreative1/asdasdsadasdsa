# Proxy Pool

Public HTTP, HTTPS, SOCKS4 ve SOCKS5 proxy kaynaklarını periyodik olarak çeker, erişilebilirlik ve gecikme kontrolü yapar, sağlıklı proxyleri SQLite havuzunda tutar.

Proxy “sağlıklı” sayılmak için 2000 ms içinde cevap vermeli, Google 204 kontrolünü geçmeli ve en az iki ayrı kontrolde başarılı olmalıdır. Varsayılan başarı oranı %100’dür; bu, tek seferlik çalışan proxylerin havuza girmesini engeller. `MAX_CANDIDATES_PER_CYCLE=0` tüm adayları test eder.

## Kurulum

```bash
python -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
python run.py
```

API: `http://localhost:8000/health` ve `http://localhost:8000/proxies?limit=50`

Manuel kaynak yenileme: `POST /refresh` (API key ayarlıysa `X-API-Key` header gerekir).

Protokole göre listeleme: `/proxies/http`, `/proxies/https`, `/proxies/socks4`, `/proxies/socks5`.

## GitHub Actions

`CI` workflow’u her push ve pull request’te projeyi kontrol eder. `Proxy pool refresh` workflow’u 15 dakikada bir kaynakları çekip kontrol eder ve doğrulanmış snapshot dosyalarını `data/proxies.txt` ile `data/proxies.json` olarak günceller. GitHub repo ayarlarında Actions’ın `Read and write permissions` izni açık olmalıdır.

Durum ve kaynak metrikleri: `GET /metrics`. Servis her kontrol turunda başarısız proxyleri puanlar, beş veya daha fazla ardışık başarısızlıkta düşük başarı oranlı kayıtları temizler ve havuzu yeniden doldurur. `MAX_CANDIDATES_PER_CYCLE` ile kaynakların aşırı büyümesi engellenir.

`/proxies` en az 50 sağlıklı proxy yoksa 503 döndürür. Public proxyler sık sık kapanabildiği için 50 sayısı garanti değil; servis havuzu sürekli yenileyip kontrol eder. Üretimde yalnızca izinli ve yasal trafik için kullanın.
