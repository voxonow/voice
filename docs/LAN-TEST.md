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

### iPhone / iPad (Safari)
1. Safari'de `https://<Mac IP>:5443/ca.cer` adresini aç. "Bu bağlantı gizli
   değil" uyarısı normal (CA henüz yok): **Ayrıntıları Göster → bu web sitesini
   ziyaret et**. Mac'ten AirDrop ile `.dev-keys/lan/ca.cer` göndermek de olur.
2. "Profil indirildi" der. **Ayarlar → Genel → VPN ve Aygıt Yönetimi →
   "Voxonow Voice DEV CA" → Yükle.**
3. **Ayarlar → Genel → Hakkında → Sertifika Güven Ayarları →** "Voxonow Voice
   DEV CA" için tam güveni **aç**. (Bu adım atlanırsa sayfa açılır ama ses
   bağlantısı kurulmaz.)
4. `https://<Mac IP>:5443` artık uyarısız açılmalı.

### Android (Chrome)
1. Chrome'da `https://<Mac IP>:5443/ca.cer` → uyarıyı geç → dosya iner.
2. **Ayarlar → Güvenlik → Şifreleme ve kimlik bilgileri → Sertifika yükle →
   CA sertifikası** → indirilen dosyayı seç. (Menü adları üreticiye göre
   değişir.)
3. Chrome kullanıcı CA'larına güvenir. Android Firefox için ayrıca: Ayarlar →
   Firefox Hakkında → logoya 5 kez dokun → Gizli ayarlar → "Use third party CA
   certificates" açık.

### Başka bir Mac (Safari, Chrome)
1. `ca.cer`'i indir ya da kopyala, çift tıkla → Anahtar Zinciri Erişimi
   "giriş" anahtar zincirine ekler.
2. Sertifikayı aç → **Güven → "Bu sertifikayı kullanırken": Her Zaman Güven.**
3. Firefox, macOS'ta sisteme eklenen CA'lara genelde güvenir; güvenmezse:
   Firefox Ayarlar → Gizlilik ve Güvenlik → Sertifikaları Göster → Otoriteler
   → İçe Aktar → "web sitelerini tanımlamak için güven".

### Windows (Chrome, Edge)
1. `ca.cer`'e çift tıkla → **Sertifika Yükle → Geçerli Kullanıcı → "Tüm
   sertifikaları şu depoya yerleştir" → Güvenilen Kök Sertifika Yetkilileri.**
2. Firefox için yukarıdaki Firefox adımı.

### Bu Mac
Bu Mac'teki tarayıcılardan da `https://<Mac IP>:5443` kullanılacaksa CA'yı
yukarıdaki "Başka bir Mac" adımlarıyla bu Mac'e de ekle.

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
