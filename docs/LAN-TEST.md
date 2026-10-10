# Yerel ağda gerçek cihaz testi

M1'i kapatmak için gereken iki elle testin hazırlığı: telefonların ve başka
bilgisayarların, bu Mac'te çalışan demoya **yerel ağ üzerinden HTTPS ile**
bağlanması ve kayıplı ağın taklit edilmesi.

> Bu kurulum yalnız geliştirme içindir. Demo bilet sunucusu, ağdaki herkese
> bilet verir; bu yüzden yalnız yerel ağa açılır ve internete açılmamalıdır.

## 1. Demoyu başlat

```sh
cd ~/voxonow-voice
npm run dev:lan
```

Normal `npm run dev` açıksa önce durdur (aynı portları kullanırlar). Komut şunu
yazar:

```
LAN demo (local network only):
  https://<Mac IP>:5443            (Mac'in her ağ arayüzü için bir satır)
  https://<Mac adı>.local:5443
  CA to install on devices: https://<Mac IP>:5443/ca.cer
  CA SHA-256: <parmak izi>
```

Adresler Mac'in o anki ağ adreslerine göre değişir; her zaman komutun
yazdığını kullan. Aşağıda `<Mac IP>` bu adreslerden biridir.

### Neler açık, neler kapalı

| Ne | Nerede dinler | Kimden kabul eder |
|---|---|---|
| Demo sayfası + bilet + `/ws` aktarımı (HTTPS, 5443) | tüm arayüzler | **yalnız bu Mac ve aynı alt ağdaki cihazlar** (diğerleri 403) |
| Ses sunucusu sinyalleşmesi (7800) | **yalnız 127.0.0.1** | yalnız bu Mac (demo `/ws`'i ona aktarır) |
| Medya (UDP + TCP 40000–40001) | Mac'in LAN adresi | WebRTC; geçerli bilet olmadan oda yok |

- Modemde bu portlar için **port yönlendirme yapma.** Yapılsa bile demo,
  alt ağ dışından gelen bağlantıyı reddeder.
- macOS "node gelen bağlantıları kabul etsin mi?" diye sorarsa **İzin Ver**.
  Reddedilirse telefonlar bağlanamaz.
- Misafir Wi-Fi'lerinin çoğu cihazları birbirinden yalıtır ("client
  isolation"); test cihazları Mac ile **aynı** ağda olmalı.

## 2. Sertifika (her cihazda bir kez)

`npm run dev:lan` ilk çalıştırmada `.dev-keys/lan/` altında bir geliştirme
sertifika otoritesi (CA) üretir. Bu CA:

- **yalnız** bu Mac'in alt ağ(lar)ı (ör. `192.168.x.0/24`), `<Mac adı>.local`,
  `127.0.0.1` ve `localhost` için sertifika verebilir (X.509 ad kısıtı).
  Anahtarı sızsa bile başka bir site taklit edilemez; bu, başka bir ad için
  imzalanmış sertifikanın reddedilmesiyle test edildi.
- 30 gün geçerlidir. Süresi dolunca `node scripts/lan-cert.mjs --force` ile
  yenilenir ve cihazlara yeniden kurulur.
- Anahtarı yalnız bu Mac'tedir (`.dev-keys/lan/ca.key`, izin 600, git dışı).
  Cihazlara yalnız **açık** kısmı (`ca.cer`) kurulur.

**Parmak izini doğrula:** Cihazda sertifika ayrıntılarında görünen SHA-256
parmak izi, terminalde yazanla aynı olmalı. Farklıysa kurma.

Her iki telefonda da **yalnız `ca.cer`** aktarılır — `server.crt`, `server.key`
ya da `ca.key` asla. CA'yı tarayıcıdan indirmek için sertifika uyarısını
geçme; dosyayı Mac'ten doğrudan aktar.

### iPhone / iPad (Safari)
1. **Mac'ten AirDrop ile gönder:** Mac'te `open ~/voxonow-voice/.dev-keys/lan`
   → `ca.cer`'e sağ tıkla → **Paylaş → AirDrop** → iPhone'u seç. iPhone'da
   kabul et; "Profil indirildi" bildirimi gelir.
2. **Profili yükle:** **Ayarlar → Genel → VPN ve Aygıt Yönetimi** →
   "Voxonow Voice DEV CA (…, LAN only)" → yüklemeden önce ayrıntılardaki
   SHA-256 parmak izinin Mac'tekiyle (bkz. "Bu Mac", 1. adım) aynı olduğunu
   gör → **Yükle** → iPhone parolasını gir.
3. **Tam güven ver:** **Ayarlar → Genel → Hakkında → Sertifika Güven
   Ayarları** → "Voxonow Voice DEV CA" için tam güveni **aç**. (Bu adım
   atlanırsa sayfa açılabilir ama ses bağlantısı kurulmaz.)
4. Safari'de `https://<Mac IP>:5443` **uyarısız** açılmalı. Uyarı çıkarsa
   geçme; adımları kontrol et.

### Android (Chrome)
1. **Dosyayı yerel ve güvenilir bir yolla aktar:** `~/voxonow-voice/.dev-keys/lan/ca.cer`'i
   USB kablosuyla dosya aktarımı (MTP) ya da senin kontrolündeki başka bir
   yerel aktarım yoluyla telefonun İndirilenler klasörüne koy. E-posta,
   mesajlaşma uygulaması ya da herkese açık paylaşım bağlantısı kullanma.
2. **CA sertifikası olarak yükle:** **Ayarlar → Güvenlik (ve gizlilik) →
   Şifreleme ve kimlik bilgileri → Sertifika yükle → CA sertifikası** →
   aktarılan `ca.cer`'i seç. Android, CA yüklemenin riskleri hakkında kendi
   onay ekranını gösterir (bu bir tarayıcı sertifika uyarısı değil, sistemin
   CA yükleme onayıdır); dosyanın doğru olduğundan eminsen onayla. "VPN ve
   uygulama kullanıcı sertifikası" ya da "Wi-Fi sertifikası" **seçme**.
   Menü adları Android sürümüne ve üreticiye göre değişir; bulamazsan
   Ayarlar'da "CA sertifikası" diye ara.
3. **Parmak izini doğrula:** **Şifreleme ve kimlik bilgileri → Güvenilir
   kimlik bilgileri → Kullanıcı** → "Voxonow Voice DEV CA" → SHA-256 parmak izi
   Mac'tekiyle aynı olmalı; değilse hemen kaldır.
4. Chrome kullanıcı CA'larına güvenir. Android Firefox için ayrıca: Ayarlar →
   Firefox Hakkında → logoya 5 kez dokun → Gizli ayarlar → "Use third party CA
   certificates" açık.
5. Chrome'da `https://<Mac IP>:5443` **uyarısız** açılmalı. Uyarı çıkarsa
   geçme; adımları kontrol et.

### Başka bir Mac (Safari, Chrome)
1. **Dosyayı demoyu çalıştıran Mac'ten al:** o Mac'te
   `open ~/voxonow-voice/.dev-keys/lan` → `ca.cer`'e sağ tıkla → **Paylaş →
   AirDrop** → bu Mac'i seç. AirDrop yoksa USB bellek ya da senin
   kontrolündeki başka bir yerel aktarım yolu; e-posta, mesajlaşma ya da
   herkese açık paylaşım bağlantısı kullanma. Yalnız `ca.cer` — anahtar
   dosyaları asla. CA'yı HTTPS adresinden indirme (uyarı geçmek gerekir).
2. **Parmak izini doğrula** (hiçbir şeyi değiştirmez):
   ```sh
   openssl x509 -inform DER -in ~/Downloads/ca.cer -noout -fingerprint -sha256
   ```
   (Dosya başka bir klasöre geldiyse yolu ona göre değiştir.) SHA-256 değeri,
   demoyu çalıştıran Mac'tekiyle (bkz. "Bu Mac", 1. adım) aynı olmalı.
   Farklıysa **kurma**.
3. `ca.cer`'e çift tıkla → Anahtar Zinciri Erişimi "giriş" anahtar zincirine
   ekler.
4. Sertifikayı aç → Ayrıntılar'daki SHA-256 parmak izinin 2. adımdakiyle aynı
   olduğunu gör → **Güven → "Bu sertifikayı kullanırken": Her Zaman Güven.**
5. Firefox, macOS'ta sisteme eklenen CA'lara genelde güvenir; güvenmezse:
   Firefox Ayarlar → Gizlilik ve Güvenlik → Sertifikaları Göster → Otoriteler
   → İçe Aktar → "web sitelerini tanımlamak için güven".

### Windows (Chrome, Edge)
1. `ca.cer`'e çift tıkla → **Sertifika Yükle → Geçerli Kullanıcı → "Tüm
   sertifikaları şu depoya yerleştir" → Güvenilen Kök Sertifika Yetkilileri.**
2. Firefox için yukarıdaki Firefox adımı.

### Bu Mac (demoyu çalıştıran Mac)
CA'yı tarayıcıdan **indirme**: CA henüz güvenilir olmadığı için
`https://<Mac IP>:5443/ca.cer` de `ERR_CERT_AUTHORITY_INVALID` verir. Güven
uyarısını geçme; dosya zaten bu Mac'te:
`~/voxonow-voice/.dev-keys/lan/ca.cer`.

1. **Parmak izini doğrula** (hiçbir şeyi değiştirmez):
   ```sh
   openssl x509 -inform DER -in ~/voxonow-voice/.dev-keys/lan/ca.cer -noout -fingerprint -sha256
   ```
   Çıktı şu olmalı (2026-10-10'da üretilen, 9 Kasım 2026'ya kadar geçerli
   CA; `npm run dev:lan`'ın yazdığı değerle de aynı):
   `47:1B:22:86:34:ED:0A:51:A0:69:3D:34:A1:26:70:35:E2:96:0C:C6:44:09:07:4D:68:A8:EE:A0:CE:70:3D:91`
   Farklıysa **kurma**; CA yenilenmişse terminalin yazdığı yeni değeri esas al.
2. **Anahtar zincirine ekle:**
   ```sh
   open ~/voxonow-voice/.dev-keys/lan/ca.cer
   ```
   Anahtar Zinciri Erişimi açılır; anahtar zinciri olarak **giriş (login)**
   seç → **Ekle**.
3. **Güvenilir yap:** Anahtar Zinciri Erişimi → giriş → Sertifikalar →
   "Voxonow Voice DEV CA (…, LAN only)" sertifikasına çift tıkla →
   Ayrıntılar'daki SHA-256 parmak izinin 1. adımdakiyle aynı olduğunu gör →
   **Güven → "Bu sertifikayı kullanırken": Her Zaman Güven** → pencereyi kapat
   ve Mac parolanı gir.
4. **Tarayıcıları yeniden başlat:** Chrome'u tamamen kapat (⌘Q) ve aç.
   Firefox kendi deposunu kullanıyorsa aynı yerel dosyayı içe aktar: Firefox
   Ayarlar → Gizlilik ve Güvenlik → Sertifikaları Göster → Otoriteler → İçe
   Aktar → `~/voxonow-voice/.dev-keys/lan/ca.cer` → "web sitelerini tanımlamak
   için güven".
5. **Doğrula:** `https://<Mac IP>:5443` uyarısız açılmalı. Terminalden de
   (hiçbir şeyi değiştirmez):
   ```sh
   security verify-cert -c ~/voxonow-voice/.dev-keys/lan/server.crt -p ssl -s <Mac IP>
   ```
   `certificate verification successful` görmelisin.

### Test bitince kaldır
- iPhone/iPad: Ayarlar → Genel → VPN ve Aygıt Yönetimi → profil → **Profili Sil**.
- Android: Şifreleme ve kimlik bilgileri → Güvenilir kimlik bilgileri →
  Kullanıcı → sertifika → Kaldır.
- Mac: Anahtar Zinciri Erişimi → sertifikayı sil. Windows: `certmgr.msc` →
  Güvenilen Kök Sertifika Yetkilileri → sil.

## 3. Test 1 — üç gerçek tarayıcı, 30 dakika

- Katılımcılar: **gerçek Safari** (iPhone ya da Mac), Chrome ve Firefox; her
  biri **ayrı cihazda**, gerçek mikrofon ve kulaklıkla (aynı odada hoparlör
  kullanılırsa yankı testi olur, bu test değil).
- Hepsi `https://<Mac IP>:5443` → aynı oda adı → **Katıl**.
- 30 dk konuşun. Not alın: kesilme, robotik/bozuk ses, gecikme hissi, hangi
  cihazda.
- Ölçümler otomatik kaydedilir: `.dev-logs/clients.log` (her tarayıcının
  istatistikleri 5 sn'de bir) ve `.dev-logs/voice.log`. Test sonrası Claude
  bunları okuyabilir; ekrandan kopyalamak gerekmez.

## 4. Test 2 — %5 paket kaybında anlaşılırlık

`scripts/packet-loss.sh` macOS'un yerleşik `pf` + `dummynet` araçlarıyla
**yalnız demonun ses trafiğine** kayıp ve gecikme ekler.

**Kapsam ve güvenlik**
- Yalnız ses sunucusunun medya portlarına (`40000–40001`) giden/gelen ve
  yerel alt ağ içinde kalan **UDP** paketleri. TCP, diğer bütün portlar ve
  internet trafiği etkilenmez.
- Sistemin pf yapılandırması (`/etc/pf.conf`) değiştirilmez: kurallar ayrı
  bir anchor'a (`com.apple/voxonow-voice-loss`) yüklenir; pf bir referans
  belirteciyle açılır ve geri almada bu belirteç bırakılır.
- Portları ses sunucusundan başka bir süreç kullanıyorsa script uygulamayı
  reddeder.
- **30 dakika sonra kendiliğinden geri alınır;** istendiğinde `revert`.
- Varsayılan yön `out`: sunucudan dinleyicilere giden ses (M1 ölçümleriyle
  aynı). `DIRECTION=both` iki yönü de etkiler (uçtan uca kayıp ~%10 olur).

**Adımlar**
1. `npm run dev:lan` çalışırken:
   ```sh
   scripts/packet-loss.sh plan
   ```
   Hiçbir şey değiştirmez. Kapsam kontrolünü, pf kuralını ve `sudo` ile
   çalışacak betiğin **tamamını** gösterir. Oku.
2. Uygula (bir kez `sudo` parolası ister):
   ```sh
   scripts/packet-loss.sh apply --yes
   ```
3. Görüşmeye katılın ve dinleyin: konuşma anlaşılır mı, ne sıklıkla bozuluyor?
   (Ölçümler yine `.dev-logs/clients.log`'a düşer; kayıp oranı oradan
   doğrulanır.)
4. Geri al:
   ```sh
   scripts/packet-loss.sh revert
   ```
   `scripts/packet-loss.sh status` ile hiçbir kuralın kalmadığını kontrol et.

Ayarlar: `LOSS=0.05 DELAY_MS=100 DIRECTION=out PORTS=40000:40001
AUTO_REVERT_MIN=30` (ortam değişkeni olarak).

## 5. Test bitince

1. `scripts/packet-loss.sh revert` (uyguladıysan).
2. `npm run dev:lan`'ı Ctrl+C ile durdur.
3. CA'yı cihazlardan kaldır (yukarıda).
