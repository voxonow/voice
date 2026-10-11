# Yakalama zinciri ölçümü (`npm run bench:capture`)

`bench/capture-eval.mjs`, ürünün gerçek mikrofon yolunu **fiziksel mikrofon
hariç** ölçer: Google Chrome'a sahte yakalama cihazı olarak bir WAV verilir;
ses `getUserMedia` → Chrome'un yakalama işlemleri (AEC/NS/AGC) → (varsa)
gürültü bastırıcı → Opus → motor → aynı sayfadaki alıcı yolundan geçer ve üç
noktada kaydedilir: **tap** (tarayıcı işlemlerinden sonra), **sent**
(bastırıcıdan sonra, ağdan önce), **received** (alıcıda). Sonuçlar
`docs/ROADMAP.md` M6'ya girer.

## Ne ölçer, ne ölçmez

Ölçer: Chrome'un yakalama işlemleri, demo bastırıcıları (`demo/src/noise.ts`),
Krisp (yalnız LiveKit Cloud test projesinde), Opus ve motor; anlaşılırlık
(STOI/ESTOI), duraklamalardaki gürültü, seviye, üst bantlar, kesilen konuşma,
eklenen gecikme, alıcı istatistikleri. Her (zincir, koşul) tekrarlanır;
değerler medyan [min–maks].

**Ölçmez:** gerçek mikrofon, oda ve hoparlör; yankı (karşı taraftan çalan ses
yok); Firefox ve Safari (dosyadan beslenen yakalama cihazı yok — Firefox'un
sahte akışı işlemleri atlıyor, WebKit yalnız `echoCancellation` ve
`sampleRate` destekliyor); kayıplı/titrek ağ. Girişim sesleri sentetiktir
(tohumlu fan, klavye, sokak; macOS TTS ile iki yabancı konuşmacı; sentetik
yankılı oda).

## Gereksinimler

- **macOS:** korpus `afconvert` (kaydı dönüştürür) ve `say` (arka plan
  konuşmacıları, `--tts`) kullanır; `--speech` ile de macOS gerekir.
- **Google Chrome** (Playwright `channel: 'chrome'`).
- **Docker:** yalnız yerel LiveKit zincirleri için (`livekit-product`,
  `livekit-krisp`; `livekit/livekit-server:v1.13.7`).
- `.dev-keys/` (`npm run keys`). `npm run bench:capture` istemciyi ve demoyu
  derleyip aracı çalıştırır.
- Portlar boş olmalı: 5194, 7837 (ses sunucusu), yerel LiveKit için 7892, 7893
  ve UDP 50200–50240. Dolu port varsa araç **başlamaz** (aksi halde sağlık
  kontrolünü başka bir sunucu geçer ve o ölçülürdü).

## Kullanım

```sh
npm run bench:capture -- --speech /yol/kayit.m4a              # varsayılan zincirler, tüm koşullar, 3 tekrar
npm run bench:capture -- --speech kayit.wav --quick --repeats 1   # temiz + fan, hızlı
npm run bench:capture -- --tts --quick --repeats 1             # kayıt yokken duman testi (aşağıya bakın)
npm run bench:capture -- --speech kayit.wav --chains livekit-krisp --check   # yalnız kontroller, hiçbir şey başlamaz
```

`--chains a,b` zincir seçer, `--conditions a,b` koşul seçer (clean, fan,
keyboard, street, babble, room, fan@0dB, fan@15dB, fan@-36dBFS, fan@-16dBFS),
`--out <dizin>` çıktı yeri. Varsayılan çıktı
`bench-results/capture/<zaman>/` (git dışı): `report.md`, `results.json`,
`wav/<koşul>/<zincir>/{tap,sent,received}-<tekrar>.wav`, `corpus/`. **Var olan
bir dizinin üzerine asla yazılmaz**; dizin varsa araç başlamaz.

Çıkış kodları: `0` tamam, `2` bir kontrol reddetti (hiçbir şey başlatılmadı,
dizin oluşturulmadı), `1` ölçüm sırasında hata.

## Zincirler

| Zincir | Chrome yakalama | Bastırıcı | Motor | Varsayılan |
|---|---|---|---|---|
| `ours-raw` | EC/NS/AGC kapalı | yok | Voxonow, yerel | evet |
| `ours-product` | EC/NS/AGC açık (ürün ayarı) | yok | Voxonow, yerel | evet |
| `ours-rnnoise-nson` | açık | RNNoise | Voxonow, yerel | evet |
| `ours-rnnoise-nsoff` | EC/AGC açık, NS kapalı | RNNoise | Voxonow, yerel | evet |
| `livekit-product` | açık | yok | LiveKit v1.13.7, yerel | evet |
| `livekit-krisp` | açık | Krisp (etkinleşme kontrolü) | LiveKit v1.13.7, yerel | **hayır** |
| `cloud-product` | açık | yok | LiveKit Cloud **test** projesi | **hayır** |
| `cloud-krisp` | açık | Krisp | LiveKit Cloud **test** projesi | **hayır** |

Krisp ve Cloud zincirleri yalnız `--chains` ile adıyla seçilince çalışır.
`report.md`'nin "Chains" bölümü ve `results.json`'daki her ölçümün
`processing` alanı, ölçümün **hangi zincirden geçtiğini** (tanım + gerçekte
etkin olan bastırıcı) yazar.

## Krisp

- Paket (`@livekit/krisp-noise-filter`) bu reponun bağımlılığı değildir;
  team-comms'un kullandığı yapı okunur, hiçbir şey yazılmaz. Konum:
  `KRISP_PACKAGE_DIR`, yoksa `TEAM_COMMS_DIR/node_modules/...` (varsayılan
  `../team-comms`).
- Krisp ayrı bir pakete derlenir (`bench/src/capture-krisp.ts`) ve **yalnız
  bir Krisp zinciri seçildiğinde**. Krisp seçilmemişse araç team-comms olmadan
  çalışır.
- Krisp zinciri seçilip paket bulunamazsa araç açık bir hatayla durur; Krisp'siz
  bir zincire **sessizce geçmez**. Tarayıcı Krisp'i desteklemezse koşu hata
  olarak kaydedilir.
- Krisp yalnız LiveKit Cloud'da etkinleşir (filtre sunucunun `/settings`
  yanıtına bakar; yerel sunucu 404 döner). `livekit-krisp` bu yüzden yalnız
  "etkinleşti mi" kontrolüdür; ölçümü "krisp (attached, NOT enabled —
  effectively none)" olarak etiketlenir.
- Etkinlik iki kez okunur: ekledikten 2 sn sonra ve kayıt bitince. Cloud'da
  ilk okuma, sesi açıkça işlenmiş koşularda da `false` dönebildi
  (`docs/ROADMAP.md` M6, Faz 1 ölçüm notları). `cloud-krisp` koşusu iki okumada da etkin görünmezse **başarısız**
  sayılır, Krisp ölçümü olarak raporlanmaz.

## LiveKit Cloud: güvenlik modeli

Cloud zincirleri yalnız **ayrı bir LiveKit Cloud test projesine** bağlanır;
**production projesi asla kullanılmaz.** Model bir yasak listesi değil, açık
yapılandırma ister; karar verilemeyen her durumda araç başlamaz (çıkış 2).

1. **Açık yapılandırma.** Dört ayarın hepsi gerekir; ortam değişkeni ya da
   `~/.config/voxonow-bench/livekit.env` (ikisinde farklı değer varsa → ret):
   ```sh
   # ~/.config/voxonow-bench/livekit.env  (chmod 600; repoya girmez)
   LIVEKIT_BENCH_URL=wss://<test-projesi>.livekit.cloud
   LIVEKIT_BENCH_KEY=<test projesinin API anahtarı>
   LIVEKIT_BENCH_SECRET=<test projesinin API secret'ı>
   LIVEKIT_BENCH_TEST_HOST=<test-projesi>.livekit.cloud
   ```
   `LIVEKIT_BENCH_TEST_HOST`, "bu host bir test projesidir" beyanıdır ve URL'nin
   host'unu birebir tekrarlamalıdır; başka yerden yapıştırılmış bir URL tek
   başına kabul edilmez.
2. **Biçim.** Yalnız `wss://<proje>.livekit.cloud`; port, yol, sorgu, kullanıcı
   bilgisi → ret.
3. **Uygulama projesinden farklı olmalı.** Hedefin host'u, anahtarı ve secret'ı;
   ortamdaki ve (varsa) team-comms `.env*` dosyalarındaki uygulama LiveKit
   ayarlarıyla (`LIVEKIT_URL`, `NEXT_PUBLIC_LIVEKIT_URL`, `LIVEKIT_API_KEY`,
   `LIVEKIT_API_SECRET`, …) karşılaştırılır; eşleşme → ret. Bu dosyalar okunur,
   değerleri hiçbir yere yazılmaz.
4. **Gerçek hedef doğrulaması** — 1–3 geçtikten sonra, hiçbir oda açılmadan ve
   yayın başlamadan: yalnız `roomList` yetkili kısa ömürlü bir token'la test
   projesinin `RoomService/ListRooms`'u çağrılır. Anahtar kabul edilmezse (anahtar
   ile host aynı projeye ait değil), yanıt alınamazsa ya da projede bu aracın
   açmadığı (`cap-` önekli olmayan) bir oda varsa → ret. LiveKit Cloud anahtarı
   yalnız kendi projesinde geçerli olduğundan sonraki tüm token'lar bu host'la
   sınırlı kalır.
5. **Loglama yok.** URL, host, anahtar, secret ve token'lar konsola,
   `report.md`'ye ve `results.json`'a yazılmaz (hata mesajları ve istek kayıtları
   `<redacted>` ile temizlenir).

`--check` 1–3'ü çalıştırır ve ağa çıkmadan durur. Kalan risk: biri production
host'unu bilerek `LIVEKIT_BENCH_TEST_HOST` olarak beyan ederse ve production
ayarları bu makinede görünmüyorsa 1–3 bunu yakalayamaz; 4 de yalnız o an
başka oda varsa yakalar. Test projesi bu yüzden ayrı ve adıyla ayırt edilir
olmalı.

Not: Bu modelden önceki iki bulut koşusunun yerel çıktılarında
(`bench-results/capture/2026-10-11T09-09-50-162Z`, `…T10-07-56-359Z`, git dışı)
test projesinin host adı düz metin olarak duruyor; bu değişiklik o dosyalara
dokunmadı.

## Konuşma kaydı

Ölçüm gerçek konuşma ister (TTS'in içeriği ~10 kHz'de biter; üst bant
sütunları anlamsızlaşır). **Kayıt repoya eklenmez** — kişisel kayıtlar ve
lisansı belirsiz sesler git dışında kalır.

**Faz 1–2'de kullanılan kayıt:** proje sahibinin iPhone ile kaydettiği Türkçe
konuşma (`konusma.m4a`, 27,3 sn, ~16 kHz'e kadar içerik). Orijinal dosya
`/tmp` altındaydı ve artık yok. Kalan tek kopya, M6 ölçümünün ürettiği,
−26 dBFS'e seviyelenmiş ve başına/sonuna sessizlik eklenmiş türev:
`bench-results/ns/2026-10-10T19-18-41-480Z/corpus/clean.wav` (git dışı;
sha256 `e6e859af13d00ae0…`). Faz 1 koşuları bu dosyayla yapıldı
(`--speech <o dosya>`). Aynı rakamları yeniden üretmek için aynı dosya verilir;
`results.json`'daki `speech.sha256` eşleşmelidir. Bu dosya silinirse Faz 1
rakamları aynı girişle tekrarlanamaz — yedeklenmesi önerilir (repoya değil).

**Başka biri ya da yeni bir ölçüm için:**
- Kendi kaydınız: tek konuşmacı, sessiz oda, ≥ 20 sn doğal konuşma, mümkünse
  sıkıştırmasız ya da yüksek bit hızlı; `afconvert`'in okuduğu her biçim olur
  (araç mono 48 kHz'e çevirir ve −26 dBFS'e seviyeler). Yeni kayıtla alınan
  sonuçlar Faz 1 rakamlarıyla birebir karşılaştırılamaz; aynı koşuda zincirler
  birbiriyle karşılaştırılır.
- Lisansı açık bir konuşma derleminden bir kayıt (ör. CC0/CC-BY): lisansı
  kontrol edilir, repoya eklenmez, kaynağı rapora not edilir.
- `--tts`: macOS TTS ile **yalnız duman testi** (zincirlerin çalıştığını
  görmek için). Rapor bunu yazar; sonuçlar kayıtlarla karşılaştırılmaz. TTS
  koşularında 12–16 kHz sütunu ve "receive slip" anlamlı değildir (bantta içerik
  yok; uzun sessizlikler hizalamayı yanıltır).

## Ölçüt notları

STOI/ESTOI temiz kayda göredir ve ~4,3 kHz üstünü görmez; üst bant
sütunları bunun için var. "Receive slip" bir sezgiseldir (alıcı ±3 sn içinde
zarf benzerliğiyle yeniden hizalanır); Cloud ve TTS koşularında yüksek
değerler görüldü, bu yüzden Cloud karşılaştırmaları ağ öncesi **sent**
katmanından yapılır. Ayrıntı: `report.md` sonundaki açıklamalar.

## Gerçek mikrofon ya da test projesi gerektiren doğrulamalar

Bu araçla otomatik olarak yapılamayanlar:
- Gerçek mikrofon, oda, hoparlör ve yankı (kulaklıksız iki cihaz).
- Safari ve Firefox'un yakalama işlemleri (elle, gerçek mikrofonla).
- `cloud-product` / `cloud-krisp` koşusu ve 4. adımdaki gerçek hedef doğrulaması
  — yalnız test projesiyle; otomatik testler sahte yanıtla çalışır.
- Kör dinleme (Faz 2): set hazır, dinleme yapılmadı.
