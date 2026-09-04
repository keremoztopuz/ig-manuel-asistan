# ig-manuel-asistan

Instagram'ın resmi **"Bilgilerini indir"** (JSON) arşivini tarayıcı içinde, tamamen yerel
olarak analiz eden ve seçtiğiniz hesaplar için **manuel işlem kuyruğu** sunan tek dosyalık
bir tarayıcı konsolu aracı.

> **Bu araç hiçbir hesabı otomatik olarak takipten çıkarmaz veya takipçi kaldırmaz.**
> Hiçbir Instagram isteği göndermez, hiçbir veriyi hiçbir sunucuya yollamaz, hiçbir
> Instagram düğmesine tıklamaz. Yaptığı tek "dış" işlem, siz düğmeye bastığınızda bir
> profil sayfasını yeni sekmede açmaktır.

## İçindekiler

- [Ne yapar, ne yapmaz](#ne-yapar-ne-yapmaz)
- [Mimari](#mimari)
- [Kullanım](#kullanım)
- [Sekmeler](#sekmeler)
- [Manuel işlem kuyruğu](#manuel-işlem-kuyruğu)
- [Yerel kayıt ve dışa aktarma](#yerel-kayıt-ve-dışa-aktarma)
- [Güvenlik denetim listesi](#güvenlik-denetim-listesi)
- [Riskler](#riskler)
- [Bilinen sınırlamalar](#bilinen-sınırlamalar)
- [Testler](#testler)

## Ne yapar, ne yapmaz

**Yapar**

- Arşivdeki takipçi, takip edilen, gönderilmiş bekleyen istek ve gelen kutusu (DM)
  dosyalarını hem dosya yoluna hem JSON yapısına bakarak tanır.
- Kullanıcı adlarını normalize eder (boşluk, baştaki `@`, küçük harf, profil URL'sinden
  kullanıcı adı çıkarma) ve hesapları tekilleştirir.
- Altı liste üretir: beni takip etmeyenler, 1 yıldır DM'i olmayanlar, işletme (yalnızca elle
  etiket), takip etmediklerim, karşılıklı takip, gönderilmiş bekleyen istekler.
- Seçtiğiniz hesaplar için sırayla **elle** yapılacak işlemi yazar; her adımda 10–15 sn
  rastgele bekleme uygular ve sıradaki profili yalnızca siz istediğinizde açar.
- İlerlemeyi, notları ve elle işletme etiketlerini tarayıcınızın `localStorage` alanında
  tutar; JSON ve CSV dışa aktarır.

**Yapmaz**

- Takipten çıkma, takipçi kaldırma, istek iptali, mesaj gönderme veya başka bir hesap
  durumu değişikliği. Bunlar için hiçbir Instagram uç noktası çağrılmaz.
- Instagram arayüzündeki hiçbir düğmeye tıklama; hız sınırı, doğrulama veya CAPTCHA aşma.
- Parola, çerez, oturum kimliği, CSRF belirteci veya yetki başlığı okuma.
- Dış kütüphane, CDN, analitik, telemetri, `eval`, `new Function`, gizlenmiş kod veya
  dinamik betik yükleme.
- Arşiv dosyalarını herhangi bir yere gönderme; dosyalar yalnızca sekmenin belleğinde okunur.

## Mimari

Tek dosya: [`ig-manuel-asistan.js`](ig-manuel-asistan.js). Okunabilir, minify edilmemiş,
Türkçe yorumlu. Ağla ilişkili olabilecek her bölümün üstünde ne yaptığını açıklayan bir
yorum vardır.

| Bölüm | İçerik |
|---|---|
| Saf yardımcılar | mojibake düzeltme (`Ã¼` → `ü`), yol normalizasyonu, `crypto.getRandomValues` ile rastgele saniye |
| Veri seti algılama | `relationships_*` anahtarları, kök dizi + dosya adı ipucu, `participants`/`messages` yapısı, `thread_path`; gelen istekler ayrı tanınır ve **kullanılmaz** |
| Hesap modeli | `Map<normalizeKullanıcıAdı, hesap>`; orijinal yazım görüntüleme için saklanır |
| DM çözümleme | konuşma slug'ından (`ayse_1784…` → `ayse`) güvenilir eşleşme; görünen ad eşleşmesi zayıf sayılır ve işaretlenir; gruplar varsayılan dışı |
| Listeler | altı yüklem (predicate); bir hesap birden fazla listede görünebilir |
| Arayüz | Shadow DOM içinde sabit panel, `z-index: 2147483000`, açık/koyu tema, dar ekran düzeni; tüm metinler `textContent` ile yazılır (`innerHTML` yok) |
| Kuyruk | yalnızca yerel durum makinesi: etkin / duraklatıldı / bitti / iptal |
| Yerel kayıt | `localStorage["igManuelAsistan.v1.durum"]` |
| Dışa aktarma | `Blob` + `URL.createObjectURL` ile yerel indirme |

Saf mantık (`analizEt`, `veriSetiTuruBul`, `normalizeKullaniciAdi`, …) Node ortamında
`module.exports` ile dışa verilir; tarayıcıda `window.igManuelAsistan` altında salt okunur
olarak bulunur. Bu sayede hem test edilebilir hem denetlenebilir.

## Kullanım

### 1. Instagram arşivini indirin

Instagram → **Ayarlar** → **Hesaplar Merkezi** → **Bilgilerin ve izinlerin** →
**Bilgilerini indir** → hesabınızı seçin → **Bilgilerin tamamı** (ya da en azından
*Takipçiler ve takip edilenler* + *Mesajlar*) → biçim olarak **JSON** seçin.
HTML biçimi desteklenmez.

İndirdiğiniz ZIP dosyasını bilgisayarınızda bir klasöre açın. Klasör içinde tipik olarak
`connections/followers_and_following/` ve `your_instagram_activity/messages/inbox/`
bulunur; adlar Instagram sürümüne göre değişebilir, araç yola bağımlı değildir.

### 2. Script'i konsola yapıştırın

1. Tarayıcıda `https://www.instagram.com/` adresini açın (giriş yapmış olmanız gerekmez;
   araç yalnızca alan adını kontrol eder).
2. Geliştirici araçlarını açın: Chrome/Edge `⌥⌘I` (Mac) veya `F12`; Firefox `⌥⌘K`;
   Safari için önce *Ayarlar → Gelişmiş → Geliştirici menüsünü göster*.
3. **Console** sekmesine geçin.
4. [`ig-manuel-asistan.js`](ig-manuel-asistan.js) dosyasının **tamamını** kopyalayıp
   konsola yapıştırın ve Enter'a basın. Chrome ilk seferde `allow pasting` yazmanızı
   isteyebilir; bu Chrome'un kendi koruma adımıdır.
5. Sağda "Instagram Manuel Asistan" paneli açılır.

Instagram konsolu, yapıştırılan kodlara karşı bir uyarı gösterir. Bu uyarı haklıdır:
**anlamadığınız hiçbir kodu konsola yapıştırmayın.** Bu aracın kaynağı kısa ve okunabilir
tutulmuştur; yapıştırmadan önce okumanız önerilir (bkz. [Güvenlik denetim listesi](#güvenlik-denetim-listesi)).

### 3. Arşivi içe aktarın

**Veri** sekmesinde ya *JSON dosyaları seç* ile dosyaları, ya da *Arşiv klasörünü seç* ile
açtığınız klasörün tamamını seçin. Klasör seçimi, alt klasörleri de tarar ve konuşma
klasör adlarını (slug) görebildiği için DM eşleştirmesinde daha güvenilirdir.

Panel şunları gösterir:

- tespit edilen dosyalar ve türleri,
- zorunlu (takipçiler, takip edilenler) ve isteğe bağlı (istekler, DM) veri setlerinden
  hangilerinin eksik olduğu,
- okuma / JSON ayrıştırma hataları.

Ardından kullanıcı adınızı onaylayın; arşivde kişisel bilgi dosyası varsa öneri olarak
doldurulur.

## Sekmeler

| Sekme | Küme |
|---|---|
| Takip ettiklerim ama beni takip etmeyenler | takip edilenler − takipçiler |
| Son 1 yıldır DM etkileşimi olmayanlar | takip ettiklerim ∩ son 365 günde birebir DM yok |
| İşletme hesapları | yalnızca elle işaretlenenler (veya veri açıkça belirtiyorsa) |
| Beni takip eden ama benim takip etmediklerim | takipçiler − takip edilenler |
| Karşılıklı takipleştiklerim | takipçiler ∩ takip edilenler |
| Takip isteği gönderdiklerim | gönderilmiş bekleyen istekler (gelen istekler dahil değil) |

Her sekmede kullanıcı adı araması, sıralama, DM / işletme / kaynak / seçim filtreleri,
**Görünenleri seç** ve **Seçimi temizle** vardır. Kasıtlı olarak "tümünü seç" yoktur.

Her satır: kullanıcı adı ve tıklanabilir profil bağlantısı, ilişki durumu, son DM tarihi
ya da eksik-veri etiketi, işletme durumu ve elle işaretleme düğmesi, kaynak dosya, seçim
kutusu ve **Profili aç** düğmesi. *Profili aç* yalnızca
`https://www.instagram.com/<kullanıcı-adı>/` adresini yeni sekmede açar.

DM sekmesi üç durumu birbirinden ayırır ve hiçbirini "hiç yazışılmadı" olarak sunmaz:

- **Son DM 365 günden eski** — eşleşen konuşma var, tarihi eski.
- **İçe aktarılan dosyalarda birebir konuşma bulunamadı** — eşleşme yok; arşiv eksik
  olabilir, hesap adı değişmiş olabilir.
- **Mesaj arşivi yüklenmedi / eksik** — hiç DM dosyası seçilmedi.

## Manuel işlem kuyruğu

Listelerde hesap seçip **Seçilenlerden manuel kuyruk oluştur** deyince Kuyruk sekmesi
açılır. Toplu işlem düğmesi yoktur. Her hesap için ilişkisine göre şu metin gösterilir:

- Takip ediyorum, beni takip etmiyor → *Profili aç ve Instagram arayüzünden manuel olarak takipten çık.*
- Beni takip ediyor, ben takip etmiyorum → *Instagram arayüzünden takipçiyi manuel olarak kaldır.*
- Karşılıklı takip → *Profili aç; manuel olarak takipten çık. İstersen takipçiler listesinden bu kişiyi ayrıca manuel kaldır.*
- Takip isteğim bekliyor → *Profili aç ve bekleyen takip isteğini Instagram arayüzünden manuel iptal et.*

Düğmeler: **Profili aç**, **Tamamlandı olarak işaretle**, **Atla**, **Kuyruğu duraklat**,
**Devam et**, **Kuyruğu iptal et**, isteğe bağlı not alanı.

*Tamamlandı* veya *Atla* dendiğinde `crypto.getRandomValues` ile 10–15 sn arası bir geri
sayım başlar; kalan saniye gösterilir, bu sürede hiçbir şey yapılmaz ve sıradaki profil
düğmesi pasif kalır. Sayım bitince **Sıradaki profili aç** etkinleşir ve yalnızca siz
tıkladığınızda bir sonraki profil açılır. Birden fazla sekmeyi otomatik açan bir hareket
yoktur.

**Araç, Instagram'da işlemi gerçekten yapıp yapmadığınızı doğrulayamaz.** "Tamamlandı"
işareti yalnızca yerel bir kayıttır.

## Yerel kayıt ve dışa aktarma

Tamamlanan / atlanan hesaplar, kalanlar, elle işletme etiketleri, zaman damgaları ve
notlar tarayıcı profilinizin `localStorage` alanında `igManuelAsistan.v1.durum` anahtarı
altında tutulur. Bu veri tarayıcı profilinizin dışına çıkmaz; ancak aynı profilde
www.instagram.com alanına erişen başka bir script tarafından okunabilir olduğunu unutmayın.
Arşiv dosyalarının içeriği **saklanmaz**. **Yerel verileri temizle** düğmesi kaydı siler.

**Kayıt / Dışa aktar** sekmesinden analiz + günlük (JSON), hesaplar (CSV) ve işlem günlüğü
(CSV) indirilebilir. Dışa aktarılan dosyalar da yalnızca yereldir; CSV hücreleri formül
enjeksiyonuna karşı kaçışlanır.

## Güvenlik denetim listesi

Kaynak kodda kontrol edebileceğiniz maddeler:

- [x] `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon` yok → ağ isteği yok.
- [x] Instagram'ın takip/takipçi/istek/mesaj uç noktalarına hiçbir çağrı yok.
- [x] `document.cookie`, CSRF belirteci, oturum kimliği, yetki başlığı okunmuyor.
- [x] `eval`, `new Function`, `import()`, `<script src>`, Base64 ile gizlenmiş kod yok.
- [x] Dış kütüphane, CDN, analitik, telemetri yok.
- [x] Instagram DOM'una tıklama veya form gönderme yok; araç yalnızca kendi Shadow DOM'u
      içindeki öğelere dokunur.
- [x] Kaynaktaki tek dış URL kökü `https://www.instagram.com/` (profil bağlantısı).
- [x] `window.location.hostname !== 'www.instagram.com'` ise hiçbir şey yapmadan çıkar.
- [x] `innerHTML` kullanılmaz; tüm metinler `textContent` ile yazılır.
- [x] Rastgele bekleme `crypto.getRandomValues` ile üretilir.

Bunları kendiniz doğrulamak için:

```bash
grep -nE "fetch\(|XMLHttpRequest|WebSocket|sendBeacon|eval\(|new Function|document\.cookie|csrftoken|import\(|innerHTML" ig-manuel-asistan.js
```

Yorum satırları dışında sonuç dönmemelidir. `npm test` içindeki "kaynak kodda durum
değiştiren ağ çağrısı yok" testi aynı kontrolü otomatik yapar.

## Riskler

Lütfen kullanmadan önce okuyun:

- **Instagram kısıtlaması.** Bu araç işlem yapmasa da, sizin elle yapacağınız yoğun
  takipten çıkma / takipçi kaldırma işlemleri Instagram tarafından sınırlanabilir veya
  hesabınıza geçici kısıtlama getirebilir. Manuel işlem ve 10–15 sn bekleme bu olasılığı
  azaltmayı amaçlar, **sıfıra indirmez**. Araç hesap güvenliği garantisi vermez.
- **Konsola kod yapıştırmak.** Tarayıcı konsoluna yapıştırılan her kod, oturum açık
  hesabınız adına her şeyi yapabilir. Bu araç bunu yapmaz; ama bunu yalnızca kaynağını
  okuyarak doğrulayabilirsiniz. Bu depo dışından gelen kopyalara güvenmeyin.
- **Arşiv gizliliği.** İndirdiğiniz Instagram arşivi mesajlarınız dahil kişisel veri
  içerir. Bu klasörü asla bir depoya, buluta veya üçüncü tarafa yüklemeyin. Bu deponun
  `.gitignore` dosyası kök dizine açılmış arşiv klasörlerini yok sayar, ancak nihai
  sorumluluk sizdedir.
- **Kullanım koşulları.** Instagram'ın hizmet koşulları otomasyon araçlarını yasaklar. Bu
  araç otomasyon yapmaz ve yalnızca sizin indirdiğiniz veriyi okur; yine de kullanımı
  kendi sorumluluğunuzdadır.
- **Yanlış karar riski.** Listeler yalnızca arşivin alındığı andaki durumu yansıtır.
  "Beni takip etmiyor" görünen biri arşivden sonra takip etmeye başlamış olabilir. Bir
  hesapla ilgili işlem yapmadan önce profili açıp güncel durumu kendiniz kontrol edin.

## Bilinen sınırlamalar

- **İşletme hesabı durumu çevrimdışı doğrulanamaz.** Instagram arşivi, takip ettiğiniz
  hesapların işletme/profesyonel olup olmadığını içermez. Araç kullanıcı adından, addan,
  biyografiden veya takipçi sayısından tahmin yapmaz; yalnızca elle işaretlemenize izin
  verir.
- **DM arşivi eksik olabilir.** Instagram bazı konuşmaları dışa aktarmayabilir, silinmiş
  hesaplar "Instagram User" olarak gelir, konuşma klasör adları kullanıcı adıyla
  eşleşmeyebilir. "Konuşma bulunamadı" hiç yazışılmadığının kanıtı değildir. Görünen ad ile
  yapılan eşleşmeler "kesin değil" olarak işaretlenir.
- **DM eşleştirmesi klasör adına dayanır.** Tek tek dosya seçiminde klasör yolu gelmez; bu
  durumda dosyanın `thread_path` alanı kullanılır. En güvenilir sonuç için klasör seçin.
- **İlişkiler güncel olmayabilir.** Arşiv, oluşturulduğu anın fotoğrafıdır. Bekleyen
  isteklerin kabul/iptal durumu, yeni takipçiler veya takipten çıkanlar yansımaz.
- **Manuel işlem doğrulanamaz.** Araç Instagram'a hiçbir şey sormaz; "Tamamlandı" sizin
  beyanınızdır.
- **Biçim değişiklikleri.** Instagram dışa aktarma biçimini değiştirebilir. Araç yapıya
  göre tanıma yaptığı için küçük değişikliklere dayanıklıdır, ancak tanınmayan dosyalar
  "Tanınmadı" olarak listelenir.
- **Büyük arşivler.** 64 MB üstü tek dosyalar atlanır; binlerce konuşma klasörü tarayıcıda
  birkaç saniye sürebilir.
- **Yerel kayıt tarayıcıya bağlıdır.** Tarayıcı verilerini temizlerseniz veya başka bir
  tarayıcı kullanırsanız ilerleme kaybolur; JSON dışa aktarımı yedek olarak kullanın.

## Testler

Saf mantık, tarayıcı gerektirmeden Node ile test edilir. Örnek arşiv tamamen sentetiktir;
gerçek kullanıcı verisi içermez.

```bash
npm test
```

Sentetik arşivi yeniden üretmek için:

```bash
npm run fixtures
```

## Lisans

MIT — bkz. [LICENSE](LICENSE).
