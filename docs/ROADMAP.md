# Voxonow Voice — Yol Haritası

Voxonow'un LiveKit'e bağlı olmadan çalışmasını sağlayacak kendi ses ve görüntü
motoru. Bu belge geliştirme boyunca referanstır: her kilometre taşı
tamamlandığında kabul kriterlerinin sonucu ve test çıktıları aynı belgede
güncellenir. Bir aşama, kabul kriterlerinin tamamı karşılanmadan "tamam"
sayılmaz.

> **Süre:** Toplam 3–5 ay bir **tahmindir, taahhüt değildir.** Gerçek süre
> M1, M4 ve M7'deki ölçümlere ve M9'daki saha testlerine bağlıdır.

## Durum

| Aşama | Konu | Durum |
|---|---|---|
| M0 | Hazırlık ve teknik prototip | ✅ 2026-10-10 — otomatik kriterler; elle kalite onayı açık |
| M1 | Ses çekirdeği | 🟡 Başladı |
| M6 | Gürültü bastırma (M1 ile paralel) | 🟡 Başladı |
| M2 | Bağlantı dayanıklılığı ve TURN | ⚪ |
| M3 | Konuşma özellikleri | ⚪ |
| M4 | Kamera ve ekran paylaşımı | ⚪ |
| M5 | Sunucu kontrolü ve olay teslimi | ⚪ |
| M7 | İşletme, ölçek ve yük testi | ⚪ |
| M8 | Voxonow entegrasyonu (staging) | ⚪ |
| M9 | Gerçek cihaz ve saha testleri | ⚪ |
| M10 | Prod geçişi ve LiveKit'in kaldırılması | ⚪ |

⚪ başlamadı · 🟡 sürüyor · ✅ kabul kriterleri karşılandı

**Sıra:** M0 → **M1 ∥ M6** → M2 → M3 → M4 → M5 → M7 → M8 → M9 → M10.
M6 (gürültü bastırma) M1'in hemen arkasına alındı ve onunla paralel yürür:
istemci tarafında (tarayıcıda) çalıştığı için sunucu çekirdeğine bağlı değildir.
Kimlikler (M0–M10) değişmedi; yalnız sıra değişti.

---

## 1. Amaç ve kapsam

**Amaç:** Voxonow'un LiveKit'in yaptığı işi gören, Voxonow'a özel bir medya
motoruyla çalışması. LiveKit'e rakip bir altyapı ürünü **değildir**; yalnızca
Voxonow'un ihtiyacını karşılar ve Voxonow'a özel geliştirmelere zemin olur.

Bu değişiklik yalnızca bir medya kütüphanesini değiştirmek değildir: TURN
altyapısı, bağlantı kurtarma, moderasyon, olay teslimi ve işletim sorumluluğu
da bize geçer.

### 1.1 Karşılanması gereken sözleşme

Bugün Voxonow'un LiveKit'ten beklediği her şey (team-comms, 2026-10-10
itibarıyla):

**İstemci (apps/web)**
- Odaya bağlanma / ayrılma, mikrofon aç/kapat, kendini sağırlaştırma
- Kamera, ekran paylaşımı, ekran paylaşırken otomatik susturma
- Kim konuşuyor (active speakers), bağlantı kalitesi göstergesi
- Yeniden bağlanma olayları (connected, reconnecting, reconnected, disconnected)
- Cihaz seçimi ve görüşme sırasında cihaz değiştirme
- Kişi başı ses düzeyi (istemcide uygulanır)
- Katılma / ayrılma sesleri
- Gürültü bastırma (bugün Krisp — yalnız LiveKit Cloud'da çalışır)
- Görüşme sürerken bilet yenileme

**API (apps/api)**
- Süreli, yetki taşıyan katılım bileti
- Olaylar: `room_started`, `room_finished`, `participant_joined`,
  `participant_left`, `track_published`, `track_unpublished` — ses oturumu,
  varlık durumu ve görüşme geçmişi bunlardan beslenir
- Sunucu komutları: oda listeleme, katılımcı listeleme, katılımcıyı odadan
  atma (erişim kaldırma + moderasyon), yayını sessize alma (moderasyon)
- Egress: Firefox için transkript kaydı (**prodda kapalı**, 2026-10-02'de
  doğrulandı)

### 1.2 İlk sürümün bilinçli olarak dışında kalanlar

- Kayıt / egress (bugün prodda zaten kapalı; gerekirse sonra)
- Uçtan uca şifreleme (E2EE)
- Çok bölgeli sunucular, ses sunucularının birbirine bağlanması (cascading)
- AI ajanları, dışarıdan yayın alma (RTMP/WHIP ingress)

---

## 2. Temel mimari kararlar (sabit)

Bu kararlar değiştirilecekse önce bu bölüm güncellenir, gerekçesi
[Değişiklik günlüğü](#8-değişiklik-günlüğü)'ne yazılır.

**K1 — Oda bazlı motor seçimi.** Bir oda tek bir medya motoruna bağlıdır;
katılan herkes aynı motoru kullanır. Motor, oda (ses oturumu) açılırken **bir
kez** seçilir ve oturuma yazılır; oda bitene kadar değişmez. Aynı kanalda bir
kişinin LiveKit'te, diğerinin yeni motorda olması imkânsız olmalıdır.

**K2 — Bağımsız geliştirme.** Motor bu repoda (`voxonow/voice`, private)
geliştirilir. Prototip test bileti ile çalışır. **M8'e kadar team-comms'a,
staging'e ve prod'a dokunulmaz.**

**K3 — Güvenli geçiş.** Yük testleri prod sunucusunda **asla** yapılmaz; ayrı,
geçici bir Hetzner sunucusunda yapılır. Prod'a geçiş, geri dönüş ve eski
istemciler birlikte tasarlanır (bkz. [§6](#6-geçiş-ve-geri-dönüş-tasarımı)).
Yeni motor, M7 yük testleri, M9 saha testleri ve **M6 gürültü bastırma
doğrulaması** geçilmeden prodda varsayılan olmaz.

**K4 — Medya çekirdeği: mediasoup.** Node.js (backend ile aynı dil), olgun,
mobilde `react-native-webrtc` ile çalışır. Uygunluğu M1/M7/M9 ölçümleriyle
doğrulanır. _Bilinen eksik: ses için RED yok (M1 B1) — 2026-10-10'da risk
olarak kabul edildi; yeniden açma koşulu M1 B1'de._

**K5 — Ayrı servis, kendi sinyalleşmesi.** Ses sunucusu ayrı bir süreç /
container'dır ve kendi WebSocket sinyalleşmesini taşır; Voxonow'un Socket.IO'suna
bağlı değildir. Böylece ileride ayrı bir sunucuya taşınması yapılandırma
değişikliğidir.

**K6 — Katılım bileti: Ed25519 imzalı kısa ömürlü JWT.** Bileti Voxonow API
**özel anahtarla** imzalar; ses sunucusu yalnız **açık anahtarı** bilir. Ses
sunucusunun yapılandırması sızsa bile bilet üretilemez. Bilet; kullanıcı,
oda, görünen ad, yayın yetkileri (ses / kamera / ekran), `iat`/`nbf`/`exp` ve
tek kullanımlık `jti` taşır.

**K7 — Olay teslimi: imzalı webhook + sıra numarası + mutabakat.** İmza,
zaman damgası toleransı, tekrar oynatma koruması, olay kimliğiyle idempotency,
oda başına artan sıra numarası (eski olaylar yok sayılır), üstel geri çekilmeli
yeniden deneme. Bunların üstünde **mutabakat**: API belirli aralıklarla odadaki
gerçek durumu sorar ve kendi kaydını düzeltir. Webhook tek başına güvence
sayılmaz.

**K8 — Moderasyon ve yetkiler sunucuda uygulanır.** Sessize alma, odadan atma
ve yayın yetkisi (kamera / ekran) sunucuda uygulanır; istemciye yalnız bilgi
verilir. Değiştirilmiş bir istemci bu kararları aşamaz.

**K9 — Bir oda = bir router.** İlk sürümde her oda tek bir mediasoup router'ında
(tek worker) çalışır. `pipeToRouter` yalnız router'lar arası medya taşıma
mekanizmasıdır, ölçeklenmeyi tek başına garanti etmez; **her büyük oda için
otomatik uygulanmaz.** Bir odayı birden fazla worker'a yaymak, ancak M7 yük
testi tek worker sınırını gösterirse ve o büyüklükte gerçek oda ihtiyacı varsa
yapılır.

**K10 — Codec.** Ses: Opus. Video: VP8 + simulcast (3 katman). Ekran
paylaşımı: VP8, metin okunabilirliği öncelikli.

**K11 — TURN: coturn.** Süreli kimlik bilgileri (TURN REST yöntemi), UDP + TCP +
TLS/443. İç ve özel IP aralıklarına aktarma yasak (SSRF koruması).

---

## 3. Mimari

```
Tarayıcı / mobil  ──  @voxonow/voice-client (mediasoup-client)
   │  WebSocket (sinyalleşme, bilet ile kimlik doğrulama)
   │  WebRTC medya (UDP; gerekirse TURN üzerinden TCP/TLS)
   ▼
voice server  (bu repo: Node + mediasoup, ayrı container)
   │  imzalı webhook (olaylar)         ▲  imzalı yönetim API'si
   ▼                                   │  (listeleme, atma, susturma)
Voxonow API (team-comms)  ── bilet imzalar (Ed25519 özel anahtar)
coturn  ── kısıtlı ağlar için TURN
```

**Repo düzeni**
- `server/` — ses sunucusu (mediasoup, sinyalleşme, bilet doğrulama, oda yönetimi)
- `client/` — `@voxonow/voice-client` istemci kütüphanesi (web ve mobil ortak)
- `demo/` — bağımsız test sayfası
- `docs/` — bu belge ve protokol notları

---

## 4. Her aşamada geçerli gereksinimler

**Güvenlik tabanı**
- Sinyalleşmedeki her mesaj şema ile doğrulanır; bilinmeyen alan / tip reddedilir.
- Kimliği doğrulanmamış bağlantı kısa sürede (≤ 5 sn) kapatılır.
- Mesaj boyutu ve mesaj hızı bağlantı başına sınırlıdır.
- WebSocket `Origin` izin listesiyle kontrol edilir.
- Bir istemci yalnız kendi odasındaki yayınlara erişebilir (oda izolasyonu).
- Repoda gizli anahtar yoktur; test anahtarları yalnız testte üretilir.
- Bağımlılıklar `npm audit` ile CI'da kontrol edilir.
- Prod sunucusunda açılacak UDP aralığı en küçük gerekli aralıktır; güvenlik
  duvarı kuralları bu belgeye yazılır. (M0 itibarıyla: worker başına 1 UDP +
  1 TCP port, `RTC_PORT_BASE`'den başlayarak; sinyalleşme portu yalnız ters
  vekil sunucu arkasından.)

**Tarayıcı matrisi** — Chrome, Safari ve Firefox **M1'den itibaren** her
aşamada denenir; M9'a bırakılmaz. iOS Safari'nin otomatik oynatma kısıtları ve
Firefox'un simulcast farkları özellikle izlenir.

**Ölçüm** — Medya kalitesi tarayıcı `getStats()` verisiyle ölçülür:
RTT, jitter, paket kaybı, gizlenen (concealed) ses oranı, alınan/gönderilen bit
hızı. Sunucuda worker başına CPU ve bellek ölçülür.

**Ortam** — Geliştirme yerelde. Staging testleri başlangıçta mevcut sunucuda,
CPU/RAM sınırlı container ile. Yük testi yalnız ayrı geçici sunucuda.

---

## 5. Kilometre taşları

Her aşamanın sonunda "Sonuçlar" alt başlığı doldurulur: tarih, commit, ölçülen
değerler, test çıktısı özeti ve varsa sapmalar.

### M0 — Hazırlık ve teknik prototip

**Kapsam**
- Repo iskeleti: npm workspaces (`server`, `client`, `demo`), TypeScript,
  test altyapısı, CI.
- Yerel geliştirme: doğrudan çalıştırma ve Docker ile çalıştırma.
- Teknik prototip: test bileti ile iki tarayıcının aynı odaya güvenli biçimde
  girip ses alışverişi yapması. Kapsam: mediasoup tarayıcı istemcisi, bilet
  doğrulaması, oda izolasyonu, WebRTC transport yaşam döngüsü
  (oluştur → bağla → yayınla → tüket → kapat).

**Güvenlik**
- Ed25519 bilet doğrulaması: imza, `aud`, `iss`, `exp`, `nbf`, oda eşleşmesi,
  `jti` tek kullanım.
- İlk mesaj bilet değilse ya da süre içinde gelmezse bağlantı kapanır.
- Şema doğrulaması, mesaj boyutu sınırı, Origin kontrolü.

**Kabul kriterleri**
- [x] `npm ci` + typecheck + birim testleri yerelde ve CI'da yeşil.
- [x] Uçtan uca test: iki headless Chromium aynı odaya katılır; her biri
      karşı taraftan **5 sn içinde ≥ 50 ses paketi** alır (`inbound-rtp`).
- [x] Oda izolasyonu testi: A odasındaki istemci B odasındaki yayından hiç
      paket almaz.
- [x] Reddedilen biletler testi: yanlış imza, süresi geçmiş, henüz geçerli
      olmayan, yanlış `aud`, tekrar kullanılan `jti` → bağlantı kapanır.
- [x] Bilet göndermeyen bağlantı ≤ 5 sn içinde kapanır.
- [x] Docker imajı derlenir; `docker compose up` ile demo çalışır.

**Sonuçlar** — 2026-10-10

- **Uçtan uca (Playwright, Chromium, sahte mikrofon):** iki katılımcı her iki
  yönde ≥ 50 ses paketine katılımdan **~2 sn** içinde ulaştı (sınır 5 sn).
  Oda izolasyonu: ayrı odadaki katılımcı 0 paket, 0 abonelik, 0 katılımcı
  gördü; kendi yayını sunucuya ulaşıyordu. Ayrılma diğer tarafa ≤ 5 sn'de
  yansıdı. Aynı 3 test hem doğrudan çalıştırmada hem `docker compose up`
  yığınında geçti.
- **Sunucu testleri (vitest, gerçek mediasoup worker'ları): 41/41.**
  Bilet ret durumları: başka anahtar, süresi geçmiş, `nbf` gelecekte, yanlış
  `aud`/`iss`, `jti` yok / kısa / tekrar, `exp` geçerli ama 10 dk'dan eski,
  bilinmeyen kaynak, bozuk oda kimliği, ad yok, HS256, `alg: none`, JWT değil.
  Sinyalleşme: bilet gelmezse kapatma (varsayılan 5 sn), ilk mesaj `join`
  değilse kapatma, `join` sürerken ikinci mesaj, protokol sürümü uyuşmazlığı,
  izinsiz Origin (403), yanlış yol (404), bozuk JSON (1007), aşırı büyük mesaj
  (1009), mesaj seli (4008), aynı kullanıcının ikinci bağlantısı (4009, eski
  kapanır), izinsiz kaynak yayınlama (`forbidden`), yanlış medya türü,
  başkasının transport'una erişim (`not_found`), yön başına tek transport,
  bilinmeyen metot / bozuk veri, son katılımcı çıkınca odanın kapanması.
- **Bağımlılık denetimi:** `npm audit --audit-level=high` → 0 açık.
- **Docker:** sunucu konteyneri `node` (uid 1000) kullanıcısıyla çalışıyor;
  konteynerde yalnız açık anahtar var. Sunucu imajı 407 MB (küçültme M7'de).

- **Gecikme A/B (`npm run bench:latency`, `bench/latency.mjs`):** aynı
  tarayıcı sayfasında yayıncı Web Audio ile 0,5 sn'de bir 50 ms'lik 1 kHz bip
  gönderir; abone, bip'in gelişini aynı `AudioContext` saatiyle
  `AudioWorklet` içinde yakalar. Ölçülen yol: yakalama aktarımı, Opus
  kodlama, ağ, medya sunucusu, jitter tamponu, çözme. **Fiziksel mikrofon ve
  kulaklık/hoparlör gecikmesi ölçüm dışındadır** (iki motor için aynıdır).
  Koşullar: tek Mac (Apple Silicon), headless Chromium (Playwright), iki
  motor da Docker Desktop içinde (yerel LiveKit: team-comms
  `livekit-server v1.13.7`, `livekit-client 2.21.0` varsayılanları — bugünkü
  Voxonow kullanımı), 3 tur × 20 bip = motor başına 60 ölçüm.

  | Motor | Medyan | p90 |
  |---|---|---|
  | Yeni motor (mediasoup) | 54 ms | 76 ms |
  | LiveKit | 69 ms | 71 ms |

  Yeni motor Docker'sız çalıştırıldığında: medyan 54 ms, p90 55 ms — p90'daki
  fark Docker Desktop'ın UDP katmanına bağlanıyor (kanıtlanmadı; M1'de Linux
  üzerinde tekrar ölçülür). Sonuç: yeni motor gecikmede LiveKit'ten geri
  değil.
- **Elle doğrulama — TAMAMLANMADI.** Otomatik kriterlerin tamamı geçti; elle
  kalite onayı yok:
  - Chrome 154 → Safari 26.6 (gerçek Safari), aynı Mac, kablolu mikrofon +
    kulaklık: ses ulaştı (paket kaybı 0, RTT 1 ms, oynatma tamponu 30 ms),
    susturma iki yönde çalıştı. **Ancak kullanıcı sesin geç geldiğini ve
    arka plan seslerinin tamamının duyulduğunu bildirdi.** Gecikme yukarıdaki
    A/B ile LiveKit'ten farksız ölçüldü; arka plan sesi Krisp'in yokluğundan
    (bkz. M6). Kalite onayı M6 ve M9'a kadar açık.
  - Firefox: yalnız otomatik (Playwright, sahte medya); gerçek cihazla
    denenmedi.
  - Safari ↔ Chrome otomatik testi WebKit (Playwright) ile yapıldı; WebKit
    gerçek Safari'nin yerine geçmez.
- **Elle testte bulunan ve düzeltilen hatalar:** (1) yerel kurulum medyayı
  `127.0.0.1` ile duyuruyordu; Firefox loopback adresine ICE eşleştirmediği
  için ses hiç akmıyordu → `npm run dev` artık LAN adresini duyuruyor;
  (2) ICE kurulamadığında demo sessiz kalıyordu → istemciye
  `mediaStateChanged` olayı eklendi; (3) demo kutularının görünür etiketi
  yoktu, iki pencere farklı odalara girdi → etiketler ve "odada yalnızsın"
  uyarısı; (4) Safari otomatik oynatma engeline karşı "Sesi başlat" düğmesi.
  Teşhis için `npm run dev` sunucu ve tarayıcı loglarını `.dev-logs/`
  klasörüne yazıyor.

**M0'da alınan tasarım kararları**
- **Worker başına tek medya portu** (mediasoup `WebRtcServer`, UDP + TCP).
  Güvenlik duvarında açılacak aralık = worker sayısı kadar port
  (`RTC_PORT_BASE … RTC_PORT_BASE + NUM_WORKERS − 1`), binlerce port değil.
- **Bilet:** Ed25519 (`EdDSA`), en fazla 10 dk yaşında, 5 sn saat toleransı,
  `jti` tek kullanımlık. Sunucu özel anahtar verilirse başlamaz.
- **Protokol paketi ikiye ayrıldı:** ana giriş bağımlılıksız tip/sabit
  (istemci paketine zod girmez), `/schemas` sunucu doğrulaması. Şemalarla
  tiplerin aynı olduğu derleme anında kanıtlanır.
- **Origin:** tarayıcıdan gelen bağlantılarda izin listesi zorunlu; Origin
  göndermeyen (mobil / yerel) istemciler bilet ile kabul edilir.
- **Aynı kullanıcı aynı odaya ikinci kez katılırsa** eski bağlantı kapanır
  (LiveKit'teki aynı kimlik davranışı).
- **Tüketiciler (consumer) duraklatılmış oluşturulur,** istemci izi
  bağladıktan sonra devam ettirilir; ilk paketler kaybolmaz.

**Sonraki aşamalara devredilenler**
- `jti` hafızası süreç içinde tutuluyor → tek sunucu örneği varsayımı. Birden
  fazla ses sunucusu olursa ortak depo gerekir (M7).
- Worker çökmesinde odalar kapatılıyor ve worker yeniden başlatılıyor; bunun
  testi ve istemcinin otomatik geri dönüşü M2/M7'de.
- Safari ve Firefox M0'da denenmedi; §4 gereği M1'den itibaren her aşamada.
- Sunucu imaj boyutu (407 MB).

### M1 — Ses çekirdeği

🟡 Başladı (2026-10-10).

**Kapsam**
- Opus ses, mikrofon aç/kapat (sunucuda producer pause/resume), ayrılma.
- Birden fazla oda; her CPU çekirdeği için bir worker (başlangıç), odalar
  worker'lara yük durumuna göre yerleşir.
- `getStats` tabanlı ölçüm aracı (demo sayfasında ve testlerde).

**Güvenlik**
- Yayın yetkisi biletten gelir; yetkisi olmayan kaynak (ör. ses yetkisi yok)
  yayınlanamaz.
- Bağlantı başına mesaj hızı sınırı.

**Kabul kriterleri**
- [ ] Chrome + Safari + Firefox, 3 katılımcı, **30 dk** kesintisiz konuşma.
      _Otomatik kısmı geçti (Chrome + Firefox + WebKit, 30 dk, 0 kesinti);
      **gerçek Safari ve gerçek cihazlarla elle 30 dk açık.**_
- [x] Temiz ağda: paket kaybı < %1, RTT p95 kayda geçer (yerel ağ hedefi
      < 50 ms). _%0 kayıp, RTT p95 1 ms (tek makine)._
- [ ] Yapay ağ bozulması (`tc netem`): %5 kayıp + 100 ms gecikme altında
      ses anlaşılır kalır; gizlenen ses oranı ve jitter ölçülüp yazılır.
      _Ölçüldü ve yazıldı (aşağıda); bozulma yalnız sunucu → alıcı yönünde
      uygulanabildi. **"Anlaşılır" kısmı kulakla doğrulanmadı;** RED eksikliği
      bulgusu (B1) açık._
- [x] Katılımcı başına worker CPU ve bellek ölçülür ve yazılır. _macOS
      ölçümü; Linux ölçümü M7._
- [x] Mikrofon kapatıldığında karşı tarafa paket gitmediği ölçümle doğrulanır.
      _Susturulan cihazdan da hiç paket çıkmıyor (e2e testi)._

**Sonuçlar** — 2026-10-10 (ara checkpoint; **M1 tamamlanmadı** — gerçek
cihaz testleri açık; tamamlanana kadar production'a geçiş yok)

Ölçüm aracı: `bench/quality.mjs` (`npm run bench:quality`). Tek Mac
(Apple Silicon, macOS), tarayıcılar headless Playwright (Chromium 156,
Firefox 157, WebKit 27.2) ve sahte mikrofon; tek mediasoup worker. "Kesinti":
bir alıcı–gönderici çiftinin 5 sn'lik pencerede 5'ten az ses paketi alması
(Opus konuşmada 50 paket/sn, DTX sessizliğinde ~2,5 paket/sn).

- **30 dk, Chrome + Firefox + WebKit:** 0 kesinti; %0 kayıp; RTT p50/p95
  1/1 ms; jitter p95 6 ms; her çift her 5 sn'de ≥ 250 paket (≈ 50/sn);
  worker CPU ort. %5,7 (tek çekirdeğin yüzdesi), bellek en fazla 8,3 MB ve
  30 dk boyunca büyümedi. Kalıcı oynatma tamponu: WebKit'in **gönderdiği**
  ses ~90 ms, diğer bütün çiftler 30–35 ms (bkz. B2).
- **Worker CPU (yalnız ses, tek oda, 45 sn, Chromium):**

  | Katılımcı | İletilen ses akışı N×(N−1) | Worker CPU | Bellek |
  |---|---|---|---|
  | 2 | 2 | %2,6 | 9,5 MB |
  | 4 | 12 | %7,5 | 10,1 MB |
  | 8 | 56 | %18,2 | 11,3 MB |
  | 12 | 132 | %28,5 | 12,8 MB |

  CPU katılımcı sayısıyla değil **iletilen akış sayısıyla** büyüyor: akış
  başına ~%0,2 (+ ~%2 taban). Tarayıcılar aynı makinede çalışırken macOS'ta
  ölçüldü; sunucu (Linux) kapasitesi M7'de ölçülür.
- **`tc netem`, 100 ms gecikme + %5 kayıp (yalnız sunucu → alıcı; Docker
  Desktop çekirdeğinde ters yön için `ifb` yok), 90 sn, 3 tarayıcı:** 0 kesinti;
  ölçülen kayıp %5,09; RTT 102/104 ms; jitter p95 7 ms; gizlenen ses çift
  başına %4,3–5,2 (≈ kayıp oranı). Aynı koşulda LiveKit: RED kullanan Chrome ↔
  WebKit çiftlerinde %0,2–0,3, Firefox'lu çiftlerde %4,5–5 (bkz. B1).
- **A/B, temiz ağ, aynı 3 tarayıcı, 60 sn (LiveKit: `bench/livekit.yaml`,
  aynı sürüm, LAN adresi):** kesinti/kayıp ikisinde de 0; kalıcı oynatma
  tamponu bizde WebKit kaynaklı çiftlerde ~90 ms, LiveKit'te ~61 ms; diğer
  çiftler eşit (30–35 ms).
- **Testler:** sunucu 42/42 (yeni: oda → worker yerleşimi); uçtan uca 6/6
  (yeni: susturma kaynakta 0 paket; Chrome ↔ Firefox ve Chrome ↔ WebKit iki
  yönlü ses + iki yönlü susturma). Uçtan uca paket Linux'ta da (Playwright
  imajı) 6/6; CI artık Chromium, Firefox ve WebKit kuruyor.

**M1 değişiklikleri:** susturmada cihazdan hiç RTP çıkmaz (`zeroRtpOnPause`;
önceden sunucuya saniyede ~5 sessizlik paketi gidiyor, sunucu iletmiyordu);
demo istatistikleri gönderici başına (kayıp, jitter, gizlenen ses, oynatma
tamponu ham sayaçları) ve mikrofonsuz katılımcıda RTT; `RoomManager.get`.

**Opus bit hızı — karar (2026-10-10): varsayılan 48 kbps.** Önceki
varsayılan Chrome'un kendi değeriydi: kodlayıcı hedefi **32 kbps**
(`webrtc-internals` dökümü). LiveKit aynı tarayıcıda **48 kbps** hedefliyor.
Karşılaştırma (`npm run bench:codec`): aynı kaynak, aynı Chrome Opus
kodlayıcısı, bizim motor; kaynak Web Audio (yankı engelleme / gürültü
bastırma / kazanç devre dışı — yalnız codec farkı ölçülür).

| Kaynak | Bit hızı | Gönderilen (ort.) | Spektral uzaklık (orijinale) |
|---|---|---|---|
| Gerçek konuşma (iPhone, 24 sn, içerik ~16 kHz'e kadar), 50 Hz–15,5 kHz | 32 kbps | 27,7 kbps | 8,5 dB |
| ″ | **48 kbps** | 41,9 kbps | **6,8 dB** |
| TTS (22,05 kHz, içerik ~10 kHz'e kadar), 50 Hz–10 kHz | 32 kbps | 23,7 kbps | 6,8 dB |
| ″ | 48 kbps | 35,7 kbps | 5,9 dB |

Bant enerjileri iki bit hızında aynı (bant kesilmiyor); fark kodlama
bozulmasında. Gerçek konuşmada iyileşme TTS'tekinin yaklaşık iki katı.
Maliyet: konuşan başına gönderilen veri ~%50 artar (28 → 42 kbps);
sunucu CPU'su paket sayısına bağlı olduğundan değişmez. Sonuçlar headless
Chromium ve Chrome 154'te aynı. **Kulakla dinleme (kullanıcı, kulaklık,
sessiz ortam): orijinal, 32 ve 48 kbps arasında fark duyulmadı.** Karar bu
yüzden kalite kazancına değil, eşitliğe dayanıyor: bugünkü Voxonow (LiveKit)
48 kbps kullanıyor; yeni motor ondan düşük başlamasın. Maliyet küçük (12
kişilik odada sunucu çıkışı ~3,7 → 5,5 Mbps; dinleyici başına ~300 → 460
kbps). Gürültülü ortam, iyi mikrofon ya da müzik gibi durumlarda fark
duyulabilir — M9'da gözlenecek. 4–8 kHz'te iki bit hızında da ~−2,9 dB düşüş var (bit hızından
bağımsız; ayrıca incelenecek).

**Açık bulgular**
- **B1 — RED yok (karar gerekiyor).** mediasoup 3.29 ses için RED'i
  desteklemiyor (`versatica/mediasoup#481`, 2022'den beri açık). Alıcı
  yönündeki kayıpta LiveKit, RED destekleyen tarayıcılar (Chrome, Safari)
  arasında kaybı neredeyse tamamen telafi ediyor; biz edemiyoruz. mediasoup
  alıcıların en kötü kayıp oranını gönderene yansıtıyor (Opus FEC yolu
  açık), ancak ölçümde FEC kaybı telafi etmedi; Opus bit hızını 64 kbps'e
  çıkarmak da değiştirmedi.
  **Karar (2026-10-10): eksiklik bilinen kalite riski olarak kabul edildi;
  mediasoup çatallanmıyor, K4 değişmedi.** Bilinen risk: kayıplı ağda
  (alıcı yönünde %5) gizlenen ses ≈ %4,5 (aynı koşulda LiveKit'in RED kullanan
  çiftlerinde %0,2–0,3). **Yeniden açma koşulu:** gerçek cihaz ve kayıplı ağ
  testlerinde (M1 elle testleri, M9) kalite kabul edilemez bulunursa K4
  yeniden açılır; o zaman mediasoup'a katkı/çatallama ile motor değiştirme
  seçenekleri gerçek ölçümlerle karşılaştırılır.
- **B2 — WebKit'in gönderdiği ses ~30 ms daha uzun tamponlanıyor.** Jitter
  bizde 5–7 ms, LiveKit'te 2 ms. Ses için transport-wide-cc'yi kapatmak, DTX'i
  kapatmak ve bit hızını artırmak etkisiz çıktı. **Sebep bilinmiyor; gerçek
  Safari'de yeniden ölçülmeden bir nedene (RED dahil) bağlanmaz** (WebKit ≠
  Safari). Açık bulgu.
- **B3 — Oda büyüdükçe CPU N² büyür** (her ses her dinleyiciye). Büyük odalar
  için yalnız konuşanların sesini iletmek gibi bir strateji M3/M7 kararı.
- **B4 — team-comms'taki yerel LiveKit `node_ip: 127.0.0.1` kullanıyor;**
  Firefox yerelde ona bağlanamıyor (bizde düzeltilen hatanın aynısı). Bu
  çalışmanın sınırı gereği team-comms'a dokunulmadı.
- **B5 — Ağ bozulması yalnız tek yönde test edilebildi;** iki yönlü test
  Linux'ta (M2/M7).

**Elle test hazırlığı (2026-10-10):** `npm run dev:lan` yerel ağda HTTPS demo
(telefonlar dahil; yalnız aynı alt ağ, sinyalleşme yalnız loopback, yalnız
LAN'a sınırlı geliştirme CA'sı) ve `scripts/packet-loss.sh` (yalnız ses
UDP portlarına kayıp/gecikme, kuru çalıştırma, otomatik geri alma). Adımlar:
`docs/LAN-TEST.md`. Testler henüz yapılmadı.

**Elle yapılması gerekenler (M1'i kapatmak için)**
- Gerçek Safari + Chrome + Firefox, gerçek mikrofon/kulaklık, 3 kişi, 30 dk.
- Kayıplı ağda (ör. macOS Network Link Conditioner, %5 kayıp) sesin
  anlaşılırlığını kulakla değerlendirme.

### M6 — Gürültü bastırma (M1 ile paralel)

**Neden öne alındı:** 2026-10-10 elle testinde arka plan seslerinin tamamı
duyuldu. Bugünkü Voxonow'da bunu Krisp bastırıyor; Krisp yalnız LiveKit
Cloud'da çalışır, yeni motorla gelmez. Kullanıcının doğrudan duyduğu fark
budur. **Gürültü bastırma bu aşamanın kriterleriyle doğrulanmadan yeni motor
production'a alınamaz** (K3, M10).

**Kapsam** — Krisp'in yerine geçecek çözüm **test sonuçlarıyla** seçilir.
RNNoise, Krisp'in eşdeğeri kabul edilmez.
- Adaylar, Krisp ile (bugünkü Voxonow / LiveKit Cloud) karşılaştırılır:
  - tarayıcının yerleşik gürültü bastırması (`noiseSuppression`; referans),
  - RNNoise (WASM),
  - uygun diğer açık kaynak modeller (ör. DeepFilterNet'in tarayıcıda
    çalışan sürümleri; lisansı ve boyutu ayrıca kontrol edilir).
- Değerlendirme boyutları: **ses kalitesi, konuşma doğallığı, eklenen
  gecikme, CPU tüketimi, yankı davranışı.**
- İşlem sırası: gürültü bastırma yankı engellemeden **sonra** çalışır.
- **RED / paket kaybı etkisiyle karıştırılmaz:** gürültü bastırma
  karşılaştırmaları kayıpsız ağda yapılır; kayıplı ağ davranışı (M1 B1) ayrı
  ölçülür ve ayrı raporlanır.
- Sunucu çekirdeğinden bağımsızdır (istemcide ses işleme); M1 ile paralel
  yürür, `@voxonow/voice-client`'a isteğe bağlı bir işlemci olarak eklenir.

**Kabul kriterleri**
- [ ] Aynı kayıtlı örnekler (klavye, fan, sokak, yankılı oda, konuşma üstüne
      konuşma) üzerinde karşılaştırmalı dinleme sonuçları yazılır; Krisp
      referans alınır. Konuşma doğallığı (kesik/robotik ses) ayrıca not edilir.
- [ ] Eklenen gecikme `bench/latency` ile ölçülür (hedef ≤ 20 ms).
- [ ] CPU etkisi masaüstünde ve düşük donanımlı bir telefonda ölçülür.
- [ ] Yankı kontrolüyle birlikte gerçek cihazlarda denenir (hoparlör +
      mikrofon, kulaklıksız).
- [ ] Seçim ve gerekçesi bu belgeye yazılır.

**Sonuçlar** — 2026-10-10, ilk nesnel ölçüm: **ön bulgu, seçim yapılmadı**
(kriterler karşılanmadı)

Araç: `npm run bench:m6` (`bench/m6/`). Kayıpsız, çevrim dışı; ağ ve RED
etkisi bu ölçüme **girmez** (o ayrı: M1 B1). Konuşma: macOS TTS (Türkçe,
"Yelda"), 21,4 sn; girişim **sentetik** (fan, klavye, sokak, iki yabancı
konuşmacı, yankılı oda), 5 dB SNR. Gerçek kayıtlar yok. Makine: bu Mac
(Apple Silicon), headless Chromium. Çevrim dışı adayların sonuçları dört
koşuda birebir aynı çıktı.

**Sınırlama:** macOS TTS sesi 22,05 kHz üretir; test konuşmasının içeriği
~10 kHz'de biter. Bu ölçüm 10 kHz üstündeki davranışı göstermez (gerçek
kayıtlar bunun için de gerekli).

Ölçütler: *gürültü azaltma* = konuşma aralarında girişe göre enerji düşüşü;
*konuşma değişimi* = konuşma karelerinde çıktı enerjisi ÷ yalnız konuşmanın
enerjisi (kusursuz bastırıcı 0 dB; eksi = konuşma kaybı); *SI-SDR
iyileşmesi* = temiz konuşmaya benzerlikteki artış (bozulmayı da cezalandırır);
*gecikme* = temiz konuşmayla bir kez ölçülür, canlı çağrıyla aynı AudioWorklet
yolu (128 örneklik bloklar); *CPU* = işlem süresi ÷ ses süresi.

| Aday | Boyut (istemci indirir) | Gürültü azaltma | Konuşma değişimi | SI-SDR iyileşmesi | Eklenen gecikme | CPU (tek çekirdek) |
|---|---|---|---|---|---|---|
| RNNoise | 157 KB | 12,0 dB | +0,1 dB | +3,9 dB | 21 ms | %0,7 |
| Speex | 56 KB | 3,0 dB | +0,4 dB | +0,8 dB | 3 ms | %0,3 |
| GTCRN | 197 KB | 21,0 dB | −1,6 dB | +7,6 dB | 32 ms | %2,0 |
| DeepFilterNet3 | 34 MB | 30,7 dB | −3,2 dB | +3,7 dB | 30 ms | %2,4 |

Koşula göre (SI-SDR iyileşmesi / gürültü azaltma, dB):

| Koşul | RNNoise | Speex | GTCRN | DeepFilterNet3 |
|---|---|---|---|---|
| fan | 7,8 / 32,0 | 3,0 / 6,6 | 10,0 / 25,6 | 12,9 / 35,8 |
| klavye | 7,0 / 6,0 | 0,0 / 0,3 | 22,4 / 48,5 | 2,7 / 54,0 |
| sokak | 4,3 / 19,9 | 1,0 / 4,1 | 8,5 / 24,1 | 10,4 / 47,5 |
| konuşma üstüne konuşma | 0,2 / 0,1 | 0,4 / 1,6 | −3,1 / 3,0 | −7,5 / 4,9 |
| yankılı oda | 0,5 / 2,1 | −0,2 / 2,4 | 0,1 / 3,9 | −0,1 / 11,4 |

**Chrome yerleşik bastırması — ölçülemedi (güvenilir değil).** Dosya, Chrome'un
sahte mikrofonuna verilerek gerçek yakalama yolundan ölçüldü; aynı dosyalarla
dört koşuda gürültü azaltma ortalaması 6,1–11,9 dB arasında değişti (koşul
bazında ör. fan 7,5–21,1 dB). Sebep belirlenmedi (hizalama ya da Chrome'un
gürültü tahmininin her oturumda farklı başlaması olabilir). SI-SDR, gecikme ve
CPU da bu yoldan ölçülemiyor (yol birkaç örnek titreşiyor; her yakalama dosyayı
kendi başından çalıyor; CPU ses servisinden ayrılamıyor). Chrome, Safari ve
Firefox yerleşik bastırması elle/gerçek mikrofonla değerlendirilecek.

**Ön bulgular (kazanan seçilmedi; gerçek kayıtlar, Krisp karşılaştırması ve
gerçek cihaz testleri olmadan seçim yapılmaz)**
- RNNoise ve GTCRN ön bulgu olarak öne çıkıyor; ikisi de küçük (≤ 200 KB) ve
  kendi sunucumuzdan barındırılabilir. RNNoise konuşmayı korur ama gürültüyü
  az siler; GTCRN daha çok siler, konuşmayı biraz kısar; gecikmesi (32 ms)
  hedefin (≤ 20 ms) üstünde, RNNoise'unki (21 ms) sınırda.
- DeepFilterNet3 en çok gürültüyü siliyor, konuşmayı en çok kısıyor; 34 MB WASM
  ve tek kişilik, 0.1.0 sürümlü bir web yapısı (`@lofcz/deepfilternet-web`)
  ciddi riskler.
- Speex bu koşullarda etkisiz düzeyde zayıf.
- Hiçbir aday yankıyı ya da arka plandaki başka konuşmaları çözmüyor; GTCRN ve
  DeepFilterNet3 orada konuşmayı bozuyor (negatif SI-SDR). Krisp'in bu iki
  durumdaki davranışı karşılaştırmada belirleyici olabilir.
- Gecikmenin bir kısmı model çerçevesi ile 128 örneklik blok uyuşmazlığından
  gelen tamponlama; azaltılabilir bir kalem.
- Elenen: `deepfilternet3-noise-filter` modeli çalışma anında üçüncü taraf bir
  CDN'den (`cdn.mezon.ai`) indiriyor ve LiveKit'e bağlı.
- Lisanslar: GTCRN ve wasm yapısı MIT, RNNoise BSD-3-Clause, DeepFilterNet
  MIT/Apache-2.0 (paket beyanı).

**Henüz yapılmayanlar (kriterler açık):** gerçek kayıtlarla ölçüm; Krisp ile
karşılaştırma (Krisp yalnız LiveKit Cloud'da çalışır → bugünkü Voxonow
üzerinden aynı örneklerle dinleme); kulakla doğallık değerlendirmesi
(dosyalar `test-results/m6/listen/<koşul>/`); tarayıcıların yerleşik
bastırması (elle); düşük donanımlı telefonda CPU; hoparlör + mikrofonla yankı
davranışı.

### M2 — Bağlantı dayanıklılığı ve TURN

**Kapsam** — üç katmanlı kurtarma:
1. **Sinyal kopması:** WebSocket koparsa oturum, kısa ömürlü bir devam
   anahtarıyla kaldığı yerden sürer; medya kesilmez.
2. **ICE bozulması:** ICE restart denenir.
3. **Transport kurtarılamazsa:** transport yeniden kurulur; son çare olarak
   odaya baştan katılınır (otomatik).
- coturn kurulumu; bağlantı kalitesi göstergesi.
- İstemci olayları: connected / reconnecting / reconnected / disconnected
  (bugünkü LiveKit olaylarının karşılığı).

**Güvenlik**
- Devam anahtarı tek kullanımlık ve kısa ömürlü; başka bağlantıdan
  kullanılamaz.
- coturn: süreli kimlik bilgileri; `denied-peer-ip` ile özel/iç aralıklar
  (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, ::1, fc00::/7, sunucunun
  kendi adresleri) yasak; açık aktarıcı (open relay) olmadığı test edilir.

**Kabul kriterleri** — kurtarma garanti değil, **ölçülen hedef**tir:
- [ ] Sunucu WebSocket'i kapattığında oturum **p90 ≤ 3 sn** içinde devam eder,
      bu sürede ses akışı kesilmez.
- [ ] ICE bozulması simülasyonunda ICE restart başarılı olur.
- [ ] ICE restart başarısız olduğunda transport yeniden kurulur; o da olmazsa
      otomatik yeniden katılım çalışır.
- [ ] Wi-Fi → mobil veri geçişi: test senaryolarının **%90'ında ≤ 5 sn**
      içinde ses geri gelir; kalanında otomatik yeniden katılım devreye girer.
      Ölçülen dağılım yazılır.
- [ ] UDP'nin tamamen engellendiği bir ağda **TURN/TCP** ve **TURN/TLS 443**
      ile ayrı ayrı bağlanılır ve ses **iki yönde** akar (alınan paket
      sayısıyla ölçülür). WebRtcServer'ın tek port kullanması tek başına bütün
      ağ senaryolarının çalıştığını kanıtlamaz; bu test onu kanıtlar.
- [ ] coturn üzerinden özel IP aralıklarına erişim denemesi reddedilir.

**Sonuçlar** — _doldurulacak_

### M3 — Konuşma özellikleri

**Kapsam**
- Konuşan algılama (sunucu tarafı), katılma/ayrılma olayları (sesler için),
  kendini sağırlaştırma, kişi başı ses düzeyi (istemci), görüşme sırasında
  cihaz değiştirme (yeniden katılmadan).
- Bilet yenileme: görüşme sürerken yeni bilet ile yetki güncelleme.

**Güvenlik**
- Bilet yenilemede yetki daralırsa (ör. kamera yetkisi kalktı) ilgili yayın
  sunucuda kapatılır.

**Kabul kriterleri**
- [ ] Konuşmaya başlama ile "konuşuyor" göstergesi arası ≤ 500 ms (ölçülür).
- [ ] Cihaz değiştirme, bağlantı yenilenmeden ≤ 1 sn içinde tamamlanır.
- [ ] Yetkisi daralan katılımcının yayını sunucuda kapanır (test).
- [ ] Üç tarayıcıda tüm özellikler elle doğrulanır.

**Sonuçlar** — _doldurulacak_

### M4 — Kamera ve ekran paylaşımı

**Kapsam**
- Kamera: VP8 + simulcast 3 katman; izleyicinin ekrandaki görüntü boyutuna
  göre katman seçimi; bant genişliği tahminine uyum.
- Ekran paylaşımı (ses ile birlikte, tarayıcı izin veriyorsa); ekran paylaşırken
  otomatik susturma istemci davranışı korunur.

**Güvenlik**
- Kamera ve ekran yetkileri biletten gelir, sunucuda zorlanır.

**Kabul kriterleri**
- [ ] 6 katılımcı kamerası açıkken, bant genişliği 300 kbps'e kısılan bir
      katılımcı diğerlerinin aldığı kaliteyi düşürmez (ölçülür).
- [ ] Görünmeyen (ekranda olmayan) videolar için gereksiz trafik gönderilmez.
- [ ] Ekran paylaşımında 1080p metin okunabilir; paylaşım başlatma ≤ 2 sn.
- [ ] Safari ve Firefox simulcast davranışı ölçülüp yazılır.
- [ ] Video yükü altında katılımcı başına CPU ve bant genişliği yazılır
      (M7 kapasite hesabına girdi).

**Sonuçlar** — _doldurulacak_

### M5 — Sunucu kontrolü ve olay teslimi

**Kapsam**
- Yönetim API'si: oda listeleme, katılımcı listeleme, katılımcıyı atma,
  yayını sessize alma (sunucuda producer pause/close).
- Olaylar: `room_started`, `room_finished`, `participant_joined`,
  `participant_left`, `track_published`, `track_unpublished`.
- Mutabakat için "odadaki gerçek durum" uç noktası.

**Güvenlik**
- Yönetim API'si yalnız imzalı isteklerle; zaman damgası toleransı ve tekrar
  oynatma koruması.
- Webhook: gövde + zaman damgası üzerinden imza, ≤ 5 dk tolerans, olay
  kimliği (idempotency), oda başına sıra numarası, üstel geri çekilmeli yeniden
  deneme, teslim edilemeyenler için kalıcı kayıt.

**Kabul kriterleri**
- [ ] Tekrar oynatılan, yinelenen ve ters sırada gelen olay testleri geçer
      (eski olay durumu bozmaz).
- [ ] Alıcı 10 dk erişilemez olduğunda olaylar sonradan sırayla teslim edilir.
- [ ] Mutabakat, kasıtlı bozulan durumu bir mutabakat aralığında düzeltir.
- [ ] Atılan katılımcının medyası ≤ 1 sn içinde kesilir; aynı biletle geri
      giremez.
- [ ] Sunucuda sessize alınan katılımcı, istemcisini değiştirse bile paket
      gönderemez (test).

**Sonuçlar** — _doldurulacak_

### M7 — İşletme, ölçek ve yük testi

**Kapsam**
- Metrikler (Prometheus), sağlık kontrolü, alarm.
- Worker / router yerleşim stratejisi; oda başına kaynak tüketimi; kapasite
  sınırları (sınıra yaklaşınca yeni oda kabulü kontrollü reddedilir).
- Worker çökmesi: yalnız o worker'daki odalar etkilenir; istemciler otomatik
  yeniden katılır.
- Yük testi **ayrı, geçici Hetzner sunucusunda** sanal katılımcılarla.

**Kabul kriterleri**
- [ ] Çekirdek başına ses ve video katılımcı kapasitesi ölçülüp yazılır.
- [ ] 4 saatlik dayanıklılık testinde bellek sürekli artmaz, kalite metrikleri
      bozulmaz.
- [ ] Bir worker kasıtlı öldürüldüğünde diğer worker'lardaki odalar
      etkilenmez; etkilenen odadaki istemciler ≤ 10 sn içinde geri döner.
- [ ] Kapasite sınırında yeni oda kontrollü reddedilir, mevcut odalar
      bozulmaz.
- [ ] Karar yazılır: tek worker yetiyor mu, `pipeToRouter` gerekli mi,
      ayrı ses sunucusunun boyutu ve zamanı.

**Sonuçlar** — _doldurulacak_

### M8 — Voxonow entegrasyonu (staging)

Bu aşamada ilk kez team-comms'a dokunulur; değişiklikler normal PR/CI akışından
geçer, prod'a ayrıca karar verilmeden çıkmaz.

**Kapsam**
- Web: ses sağlayıcısı katmanı (LiveKit ve yeni motor aynı arayüzün arkasında).
  Bu katman M1–M4 sürerken paralel hazırlanabilir.
- API: Ed25519 bilet üretimi; motor seçiminin ses oturumuna yazılması (K1);
  webhook alıcısı (K7); mutabakat işi; moderasyon ve erişim kaldırma için yeni
  yönetim API'si; admin görünümü.
- Eski istemciler: yalnız LiveKit'i bilen istemcilere ya LiveKit odası verilir
  ya da sayfayı yenilemeleri sağlanır (bkz. §6).
- Staging'de motor bir ayarla seçilir.

**Kabul kriterleri**
- [ ] team-comms'un tüm test paketi yeşil.
- [ ] Staging'de yeni motorla açılan odalar ve LiveKit ile açılan odalar
      aynı anda çalışır.
- [ ] Aynı kanal hiçbir koşulda iki motora bölünmez (test).
- [ ] Eski sürüm istemci senaryosu test edilir.
- [ ] Erişimi kaldırılan kullanıcı yeni motorda da odadan atılır.
- [ ] Staging sunucusundaki **gerçek güvenlik duvarı kuralları** doğrulanır:
      yalnız gereken portlar açık (sinyalleşme ters vekil arkasında; worker
      başına bir UDP + bir TCP medya portu; TURN portları). Docker port
      eşlemesi güvenlik duvarı yerine sayılmaz.
- [ ] Sunucuya **dışarıdan port taraması** (TCP ve UDP) yapılır; beklenmeyen
      açık port olmadığı sonuçla birlikte yazılır.

**Sonuçlar** — _doldurulacak_

### M9 — Gerçek cihaz ve saha testleri

**Kapsam**
- Cihaz matrisi: Chrome, Safari, Firefox (masaüstü), iOS Safari, Android
  Chrome; Bluetooth kulaklık; kurumsal ağ, mobil veri, zayıf Wi-Fi.
- İstemci bağlantı istatistiklerinin toplanması (gerçek kullanıcı kalite verisi).

**Kabul kriterleri**
- [ ] 2 hafta boyunca staging'de günlük kullanımda engelleyici hata yok.
- [ ] Katılım başarı oranı ≥ %99 (toplanan istatistiklerden).
- [ ] Cihaz matrisinin her satırı elle doğrulanır ve yazılır.

**Sonuçlar** — _doldurulacak_

### M10 — Prod geçişi ve LiveKit'in kaldırılması

**Kapsam** — bkz. §6.
- Ön koşul: M6 (gürültü bastırma), M7 ve M9 kabul kriterleri karşılanmış.
- Prod'da yeni odalar için yeni motor açılır; LiveKit yedekte bekler.
- Geri dönüş tatbikatı önce staging'de, sonra prod'da yapılır.
- Sorunsuz bir dönemden sonra LiveKit paketleri, anahtarları ve webhook kodu
  kaldırılır; gizlilik metni güncellenir.

**Kabul kriterleri**
- [ ] Geri dönüş tatbikatı: ayar geri alındığında yeni odalar LiveKit'te
      açılır; süren yeni-motor odaları bozulmadan sürer ya da kullanıcılar
      kontrollü yeniden bağlanır.
- [ ] Prod'da 2 hafta sorunsuz çalışma (M9 metrikleriyle).
- [ ] LiveKit kaldırıldıktan sonra team-comms test paketi yeşil.
- [ ] Gizlilik metni güncellendi.

**Sonuçlar** — _doldurulacak_

---

## 6. Geçiş ve geri dönüş tasarımı

- **Motor seçimi oda açılışında yapılır** (K1). Ayar yalnız **yeni** odaları
  etkiler.
- **Süren görüşmeler bir motordan diğerine taşınamaz.** Geri dönüş yeni
  odaları LiveKit'e yönlendirir; süren yeni-motor odaları ya kendiliğinden biter
  ya da kullanıcıların yeniden bağlanması gerekir.
- **Eski istemciler:** API, istemcinin hangi motorları desteklediğini bilir
  (istemci sürümü / yetenek bildirimi). Yeni motoru bilmeyen istemci yeni-motor
  odasına katılmak isterse sayfayı yenilemesi istenir; geçiş döneminde bu
  durumlar loglanır.
- **Geri dönüş gerçekten test edilir** (M10 kabul kriteri), varsayılmaz.

## 7. Açık konular ve riskler

- **Tek sunucu:** Başlangıçta prod, staging ve ses motoru aynı kutuda. Kutu
  düşerse hepsi gider. Ayrı ses sunucusu kararı M7'de.
- **Coğrafya:** Tek bölge (Avrupa). Uzak kullanıcılar daha yüksek gecikme
  yaşar; bilinçli tercih.
- **RED (M1 B1) — kabul edilmiş bilinen risk (2026-10-10):** mediasoup ses
  için RED desteklemiyor; kayıplı ağda Chrome/Safari arasında gizlenen ses
  ≈ %4,5 (LiveKit RED ile %0,2–0,3). Çatallama yok, K4 değişmedi; gerçek cihaz
  ve kayıplı ağ testlerinde kalite kabul edilemezse K4 yeniden açılır.
- **İşletim sorumluluğu:** Ses kesintilerinin teşhisi ve çözümü bizde;
  izleme ve alarm M7'de zorunlu.
- **Mobil uygulama:** Doğrudan `@voxonow/voice-client` üzerine yapılır;
  iOS arka plan ses ve CallKit gereksinimleri ayrıca denenir.

## 8. Değişiklik günlüğü

- **2026-10-10** — Opus bit hızı varsayılanı 48 kbps (LiveKit ile aynı);
  ölçüm M1 altında. `npm run bench:codec` eklendi. M6'ya TTS'in ~10 kHz bant
  sınırlaması notu eklendi.
- **2026-10-10** — M1 elle testleri için yerel ağ HTTPS demo ve paket kaybı
  script'i hazırlandı (`docs/LAN-TEST.md`); M6 ilk nesnel ölçümü (Chrome
  yerleşik, RNNoise, Speex, GTCRN, DeepFilterNet3). M1 ve M6 açık.
- **2026-10-10** — Kararlar: M1 ara checkpoint olarak commit (M1 açık);
  RED eksikliği bilinen kalite riski olarak kabul, çatallama yok, K4
  değişmedi (yeniden açma koşulu M1 B1'de); Safari tamponlama farkı açık
  bulgu, nedene bağlanmadı; M6 RED etkisinden ayrı ölçülür.
- **2026-10-10** — M1 ara raporu: 30 dk üç tarayıcı otomatik testi, worker
  CPU ölçeklemesi, netem ve LiveKit A/B ölçümleri; açık bulgular B1–B5 (B1:
  mediasoup'ta RED yok — karar gerekiyor). M1 tamamlanmadı.
- **2026-10-10** — M6 (gürültü bastırma) M1'in arkasına alındı, M1 ile
  paralel; production ön koşulu yapıldı. M2'ye UDP engelli ağda TURN/TCP ve
  TURN/TLS ile iki yönlü ses testi, M8'e gerçek güvenlik duvarı doğrulaması ve
  dışarıdan port taraması eklendi. M0'a gecikme A/B sonuçları ve elle
  doğrulamanın tamamlanmadığı notu eklendi. M1 başladı.
- **2026-10-10** — M0 tamamlandı (sonuçlar M0 altında). Ek kararlar: worker
  başına tek medya portu, protokol paketinin tip/şema olarak ikiye ayrılması.
- **2026-10-10** — Belge oluşturuldu. Kararlar: K1–K11. Kaynak: Voxonow sohbet
  analizi ve iki dış değerlendirme (6 teknik düzeltme + 7 ek konu + oda bazlı
  motor seçimi, bağımsız geliştirme, güvenli geçiş, `pipeToRouter` notu).
