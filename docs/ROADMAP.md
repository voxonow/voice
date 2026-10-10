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
| M0 | Hazırlık ve teknik prototip | 🟡 Başladı |
| M1 | Ses çekirdeği | ⚪ |
| M2 | Bağlantı dayanıklılığı ve TURN | ⚪ |
| M3 | Konuşma özellikleri | ⚪ |
| M4 | Kamera ve ekran paylaşımı | ⚪ |
| M5 | Sunucu kontrolü ve olay teslimi | ⚪ |
| M6 | Gürültü bastırma | ⚪ |
| M7 | İşletme, ölçek ve yük testi | ⚪ |
| M8 | Voxonow entegrasyonu (staging) | ⚪ |
| M9 | Gerçek cihaz ve saha testleri | ⚪ |
| M10 | Prod geçişi ve LiveKit'in kaldırılması | ⚪ |

⚪ başlamadı · 🟡 sürüyor · ✅ kabul kriterleri karşılandı

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
Yeni motor, M7 yük testleri ve M9 saha testleri geçilmeden prodda varsayılan
olmaz.

**K4 — Medya çekirdeği: mediasoup.** Node.js (backend ile aynı dil), olgun,
mobilde `react-native-webrtc` ile çalışır. Uygunluğu M1/M7/M9 ölçümleriyle
doğrulanır.

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
  duvarı kuralları bu belgeye yazılır.

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
- [ ] `npm ci` + typecheck + birim testleri yerelde ve CI'da yeşil.
- [ ] Uçtan uca test: iki headless Chromium aynı odaya katılır; her biri
      karşı taraftan **5 sn içinde ≥ 50 ses paketi** alır (`inbound-rtp`).
- [ ] Oda izolasyonu testi: A odasındaki istemci B odasındaki yayından hiç
      paket almaz.
- [ ] Reddedilen biletler testi: yanlış imza, süresi geçmiş, henüz geçerli
      olmayan, yanlış `aud`, tekrar kullanılan `jti` → bağlantı kapanır.
- [ ] Bilet göndermeyen bağlantı ≤ 5 sn içinde kapanır.
- [ ] Docker imajı derlenir; `docker compose up` ile demo çalışır.

**Sonuçlar** — _doldurulacak_

### M1 — Ses çekirdeği

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
- [ ] Temiz ağda: paket kaybı < %1, RTT p95 kayda geçer (yerel ağ hedefi
      < 50 ms).
- [ ] Yapay ağ bozulması (`tc netem`): %5 kayıp + 100 ms gecikme altında
      ses anlaşılır kalır; gizlenen ses oranı ve jitter ölçülüp yazılır.
- [ ] Katılımcı başına worker CPU ve bellek ölçülür ve yazılır.
- [ ] Mikrofon kapatıldığında karşı tarafa paket gitmediği ölçümle doğrulanır.

**Sonuçlar** — _doldurulacak_

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
- [ ] UDP tamamen kapalı bir ağdan TURN/TCP veya TURN/TLS 443 ile bağlanılır.
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

### M6 — Gürültü bastırma

**Kapsam** — Krisp'in yerine geçecek çözüm **test sonuçlarıyla** seçilir.
RNNoise, Krisp'in eşdeğeri kabul edilmez.
- Adaylar: tarayıcının yerleşik gürültü bastırması (referans), RNNoise
  (WASM), gerekirse başka açık kaynak modeller.
- İşlem sırası: gürültü bastırma yankı engellemeden **sonra** çalışır.

**Kabul kriterleri**
- [ ] Aynı kayıtlı örnekler (klavye, fan, sokak, yankılı oda) üzerinde
      karşılaştırmalı dinleme sonuçları yazılır; Krisp referans alınır.
- [ ] Eklenen gecikme ölçülür (hedef ≤ 20 ms).
- [ ] Düşük donanımlı bir telefonda CPU etkisi ölçülür.
- [ ] Yankı kontrolüyle birlikte gerçek cihazlarda denenir (hoparlör + mikrofon).
- [ ] Seçim ve gerekçesi bu belgeye yazılır.

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
- **İşletim sorumluluğu:** Ses kesintilerinin teşhisi ve çözümü bizde;
  izleme ve alarm M7'de zorunlu.
- **Mobil uygulama:** Doğrudan `@voxonow/voice-client` üzerine yapılır;
  iOS arka plan ses ve CallKit gereksinimleri ayrıca denenir.

## 8. Değişiklik günlüğü

- **2026-10-10** — Belge oluşturuldu. Kararlar: K1–K11. Kaynak: Voxonow sohbet
  analizi ve iki dış değerlendirme (6 teknik düzeltme + 7 ek konu + oda bazlı
  motor seçimi, bağımsız geliştirme, güvenli geçiş, `pipeToRouter` notu).
