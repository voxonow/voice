# Voxonow Voice

Voxonow'un ses ve görüntü motoru (mediasoup). Yol haritası, kararlar ve her
aşamanın kabul kriterleri: [docs/ROADMAP.md](docs/ROADMAP.md).

## Paketler

| Klasör | Paket | Ne |
|---|---|---|
| `protocol/` | `@voxonow/voice-protocol` | İstemci ↔ sunucu mesaj sözleşmesi. Ana giriş yalnız tip ve sabit (bağımlılıksız); `/schemas` sunucunun zod doğrulaması. |
| `server/` | `@voxonow/voice-server` | Ses sunucusu: bilet doğrulama, sinyalleşme (WebSocket), odalar, mediasoup worker'ları. |
| `client/` | `@voxonow/voice-client` | Web ve mobilin ortak istemci kütüphanesi. |
| `demo/` | — | Geliştirme sayfası + geliştirme bileti üreten sunucu. **Asla yayına alınmaz.** |

## Yerelde çalıştırma

Node 22 gerekir.

```sh
npm ci
npm run dev          # anahtarları üretir, derler, sunucu + demo'yu başlatır
```

http://localhost:5173 adresini iki ayrı tarayıcı penceresinde açıp aynı odaya katıl.

Telefon ve başka bilgisayarlarla yerel ağda (HTTPS, yalnız aynı alt ağ):
`npm run dev:lan` — kurulum ve güvenlik notları: [docs/LAN-TEST.md](docs/LAN-TEST.md).

Docker ile:

```sh
npm run keys         # bir kez: .dev-keys/ oluşturur
docker compose up --build
```

## Testler

```sh
npm run typecheck
npm test             # birim + entegrasyon (gerçek mediasoup worker'ları)
npm run test:e2e     # iki gerçek Chromium, gerçek WebRTC sesi
```

Çalışan bir yığına karşı uçtan uca test: `E2E_BASE_URL=http://localhost:5173 npx playwright test`.

## Ölçüm araçları (`bench/`)

```sh
npm run build
npm run bench:latency                                  # gecikme A/B: bizim motor ↔ LiveKit
npm run bench:quality -- --browsers chromium,firefox,webkit --duration 60
npm run bench:quality -- --browsers 'chromium*8' --duration 45   # worker CPU ölçeklemesi
```

- `bench:latency`: aynı sayfada bip gönderip geliş anını aynı ses saatiyle
  ölçer (mikrofon/hoparlör donanımı hariç). Yerel LiveKit gerekir.
- `bench:quality`: N katılımcı, çift başına paket akışı, kayıp, jitter,
  gizlenen ses, oynatma tamponu, RTT ve mediasoup worker CPU/bellek.
  `--engine livekit` aynı ölçümü LiveKit'e karşı yapar (`bench/livekit.yaml`
  ile LAN adresini duyuran bir LiveKit), `--external ws://…/ws` çalışan bir
  sunucuyu (ör. `tc netem` altındaki Docker konteyneri) ölçer.
- Sonuçlar `test-results/bench/` altına JSON olarak yazılır.
- `bench:m6`: gürültü bastırma adaylarının çevrim dışı nesnel karşılaştırması
  (macOS TTS ile Türkçe konuşma + sentetik gürültü); dinleme dosyaları
  `test-results/m6/listen/` altına. Ön bulgu üretir, seçim yapmaz.

## Sunucu yapılandırması

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `RTC_ANNOUNCED_ADDRESS` | — (zorunlu) | İstemcilere bildirilen genel IP/host |
| `TICKET_PUBLIC_KEY` / `TICKET_PUBLIC_KEY_FILE` | — (zorunlu) | Ed25519 **açık** anahtar (PEM). Özel anahtar verilirse sunucu başlamaz. |
| `PORT` | `7800` | Sinyalleşme + `/healthz` |
| `NUM_WORKERS` | CPU sayısı | mediasoup worker sayısı |
| `RTC_PORT_BASE` | `40000` | Worker `i` → `RTC_PORT_BASE + i` (UDP + TCP). Güvenlik duvarında yalnız bu aralık açılır. |
| `RTC_LISTEN_IP` | `0.0.0.0` | Medya soketlerinin dinlediği adres |
| `ALLOWED_ORIGINS` | boş | Virgülle ayrılmış tarayıcı origin'leri. Origin göndermeyen (yerel/mobil) istemciler bilet ile kabul edilir. |
| `TICKET_ISSUER` / `TICKET_AUDIENCE` | `voxonow-api` / `voxonow-voice` | Bilet `iss` / `aud` |
| `LOG_LEVEL` | `info` | pino seviyesi |
