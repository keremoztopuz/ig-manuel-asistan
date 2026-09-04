// Saf analiz mantığı testleri. Çalıştırma: node --test test/
// Tarayıcı gerekmez; ig-manuel-asistan.js Node ortamında yalnızca saf API'yi dışa verir.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const A = require('../ig-manuel-asistan.js');

const ARSIV = path.join(__dirname, 'fixtures', 'arsiv');
const SIMDI = Date.parse('2026-09-04T00:00:00Z');
const GUN = 24 * 60 * 60 * 1000;

// Tarayıcıdaki dosyalariOku() ile aynı biçimde dosya kayıtları üretir.
function arsiviOku(kok) {
  const dosyalar = [];
  (function gez(dizin) {
    for (const ad of fs.readdirSync(dizin)) {
      const tam = path.join(dizin, ad);
      if (fs.statSync(tam).isDirectory()) {
        gez(tam);
        continue;
      }
      if (!ad.endsWith('.json')) continue;
      const yol = path.relative(kok, tam).split(path.sep).join('/');
      const json = JSON.parse(fs.readFileSync(tam, 'utf8'));
      const tani = A.veriSetiTuruBul(yol, json);
      dosyalar.push({ yol, ad, boyut: 0, json, tur: tani.tur, kayitlar: tani.kayitlar, kayitSayisi: tani.kayitlar ? tani.kayitlar.length : null, not: tani.not });
    }
  })(kok);
  return dosyalar;
}

test('kullanıcı adı normalizasyonu', () => {
  assert.equal(A.normalizeKullaniciAdi('  @Ali.Veli '), 'ali.veli');
  assert.equal(A.normalizeKullaniciAdi('https://www.instagram.com/Foo_Bar/?hl=tr'), 'foo_bar');
  assert.equal(A.normalizeKullaniciAdi('instagram.com/foo'), 'foo');
  assert.equal(A.normalizeKullaniciAdi(''), '');
  assert.equal(A.normalizeKullaniciAdi(null), '');
  assert.equal(A.kullaniciAdiUrldenCikar('https://www.instagram.com/p/ABC123/'), null);
});

test('mojibake düzeltme', () => {
  assert.equal(A.mojibakeDuzelt(Buffer.from('Ayşe Yılmaz', 'utf8').toString('latin1')), 'Ayşe Yılmaz');
  assert.equal(A.mojibakeDuzelt('düz metin'), 'düz metin'); // gerçek Unicode dokunulmaz
  assert.equal(A.mojibakeDuzelt('ascii'), 'ascii');
});

test('veri seti algılama: yol + yapı', () => {
  const dosyalar = arsiviOku(ARSIV);
  const turler = Object.fromEntries(dosyalar.map((d) => [d.yol, d.tur]));
  assert.equal(turler['connections/followers_and_following/followers_1.json'], 'takipciler');
  assert.equal(turler['connections/followers_and_following/followers_2.json'], 'takipciler');
  assert.equal(turler['connections/followers_and_following/following.json'], 'takipEdilenler');
  assert.equal(turler['connections/followers_and_following/pending_follow_requests.json'], 'istekGonderilen');
  assert.equal(turler["connections/followers_and_following/follow_requests_you've_received.json"], 'istekGelen');
  assert.equal(turler['connections/followers_and_following/close_friends.json'], 'iliskiDiger');
  assert.equal(turler['personal_information/personal_information/personal_information.json'], 'kisiselBilgi');
  assert.equal(turler['your_instagram_activity/messages/inbox/ayse_yilmaz_17842000000000001/message_1.json'], 'dm');
  assert.equal(turler['your_instagram_activity/messages/message_requests/yabanci_17842000000000005/message_1.json'], 'iliskiDiger');
  assert.equal(turler['ads_information/ads_and_topics/ads_viewed.json'], 'bilinmeyen');
});

test('veri seti algılama: yalnızca dosya adı ile (klasör yolu yok)', () => {
  const kayit = { title: '', string_list_data: [{ href: 'https://www.instagram.com/x', value: 'x', timestamp: 1 }] };
  assert.equal(A.veriSetiTuruBul('followers_1.json', [kayit]).tur, 'takipciler');
  assert.equal(A.veriSetiTuruBul('following.json', { relationships_following: [kayit] }).tur, 'takipEdilenler');
  // Kök dizi + anlamsız ad → bilinmeyen (tahmin yapılmaz)
  assert.equal(A.veriSetiTuruBul('liste.json', [kayit]).tur, 'bilinmeyen');
  // Gelen istekler asla "gönderilen" sayılmaz
  assert.equal(A.veriSetiTuruBul('x.json', { relationships_follow_requests_received: [kayit] }).tur, 'istekGelen');
  assert.equal(A.veriSetiTuruBul('x.json', { rastgele: 1 }).tur, 'bilinmeyen');
  assert.equal(A.veriSetiTuruBul('x.json', 'metin').tur, 'bilinmeyen');
});

test('kullanıcı adı önerisi (İngilizce ve Türkçe anahtar)', () => {
  const ing = [{ string_map_data: { Username: { value: 'abc' } } }];
  const tr = [{ string_map_data: { 'Kullanıcı Adı': { value: 'xyz' } } }];
  const href = [{ string_map_data: { Profil: { href: 'https://www.instagram.com/qwe' } } }];
  assert.equal(A.kullaniciAdiOnerisiBul(ing), 'abc');
  assert.equal(A.kullaniciAdiOnerisiBul(tr), 'xyz');
  assert.equal(A.kullaniciAdiOnerisiBul(href), 'qwe');
  assert.equal(A.kullaniciAdiOnerisiBul([]), null);
});

test('eksik veri seti özeti', () => {
  const { eksikler } = A.veriSetleriniOzetle([{ tur: 'takipciler' }]);
  assert.deepEqual(eksikler.map((e) => e.tur), ['takipEdilenler', 'istekGonderilen', 'dm']);
  assert.equal(eksikler.find((e) => e.tur === 'takipEdilenler').zorunlu, true);
});

test('tam analiz: listeler, tekilleştirme, kendini atlama', () => {
  const dosyalar = arsiviOku(ARSIV);
  const r = A.analizEt(dosyalar, { kullaniciAdim: '@Test_Kullanicisi', simdiMs: SIMDI });

  // ali.veli iki takipçi dosyasında farklı yazımla geçiyor → tek hesap
  const ali = r.hesaplar.filter((h) => h.norm === 'ali.veli');
  assert.equal(ali.length, 1);
  assert.equal(ali[0].kullaniciAdi, 'Ali.Veli'); // ilk görülen orijinal yazım korunur
  assert.equal(ali[0].kaynakDosyalar.length, 3);

  // Kendi hesabı listelerde yok
  assert.equal(r.hesaplar.some((h) => h.norm === 'test_kullanicisi'), false);
  assert.ok(r.uyarilar.some((u) => u.includes('Kendi kullanıcı adınız')));

  assert.deepEqual(r.listeler.takipEtmeyenler, ['magaza_ornek', 'mehmet.kaya', 'sessiz_hesap']);
  assert.deepEqual(r.listeler.takipEtmediklerim, ['sadece_takipci']);
  assert.deepEqual(r.listeler.karsilikli, ['ali.veli', 'ayse_yilmaz', 'deneme_hesap', 'gecmis_arkadas']);
  assert.deepEqual(r.listeler.istekler, ['bekleyen_istek', 'sadece_takipci']);
  assert.equal(r.listeler.istekler.includes('gelen_istek_gonderen'), false);
  assert.deepEqual(r.listeler.isletme, []); // veride işletme alanı yok, elle etiket yok
});

test('DM durumları: var / eski / yok ve slug eşleşmesi', () => {
  const dosyalar = arsiviOku(ARSIV);
  const r = A.analizEt(dosyalar, { kullaniciAdim: 'test_kullanicisi', simdiMs: SIMDI });
  const h = Object.fromEntries(r.hesaplar.map((x) => [x.norm, x]));

  assert.equal(h['ayse_yilmaz'].sonDm.durum, 'var');
  assert.equal(h['ayse_yilmaz'].sonDm.eslesme, 'slug');
  assert.equal(h['ayse_yilmaz'].sonDm.zamanMs, SIMDI - 30 * GUN); // iki parçadan en yenisi
  assert.equal(h['mehmet.kaya'].sonDm.durum, 'eski');
  assert.equal(h['sessiz_hesap'].sonDm.durum, 'yok'); // yalnızca grupta, varsayılan dışarıda
  assert.equal(h['magaza_ornek'].sonDm.durum, 'yok');

  // "dmYok" listesi: takip ettiğim ve DM durumu 'var' olmayanlar
  assert.deepEqual(r.listeler.dmYok, ['ali.veli', 'deneme_hesap', 'gecmis_arkadas', 'magaza_ornek', 'mehmet.kaya', 'sessiz_hesap']);

  assert.equal(r.dm.arsivVar, true);
  assert.equal(r.dm.birebirSayisi, 3);
  assert.equal(r.dm.grupSayisi, 1);
  assert.equal(r.dm.eslesmeyenBirebir, 1); // instagramuser
  assert.ok(r.uyarilar.some((u) => u.includes('grup konuşması')));
});

test('DM: grup dahil seçeneği', () => {
  const dosyalar = arsiviOku(ARSIV);
  const r = A.analizEt(dosyalar, { kullaniciAdim: 'test_kullanicisi', simdiMs: SIMDI, grupDahil: true });
  const sessiz = r.hesaplar.find((x) => x.norm === 'sessiz_hesap');
  assert.equal(sessiz.sonDm.durum, 'var');
  assert.equal(sessiz.sonDm.eslesme, 'grup-ad');
  assert.equal(r.listeler.dmYok.includes('sessiz_hesap'), false);
});

test('DM: arşiv yüklenmemişse "arsivYok", asla "yok" değil', () => {
  const dosyalar = arsiviOku(ARSIV).filter((d) => d.tur !== 'dm');
  const r = A.analizEt(dosyalar, { kullaniciAdim: 'test_kullanicisi', simdiMs: SIMDI });
  assert.ok(r.hesaplar.every((h) => h.sonDm.durum === 'arsivYok'));
  assert.equal(r.dm.arsivVar, false);
  assert.ok(r.uyarilar.some((u) => u.includes('Mesaj arşivi yüklenmedi')));
});

test('DM: yol olmadan thread_path ile slug bulunur', () => {
  const kayit = (u) => ({ title: '', string_list_data: [{ value: u, timestamp: 1 }] });
  const dosyalar = [
    { yol: 'following.json', tur: 'takipEdilenler', kayitlar: [kayit('zeynep')], json: null },
    { yol: 'followers_1.json', tur: 'takipciler', kayitlar: [], json: null },
    {
      yol: 'message_1.json',
      tur: 'dm',
      kayitlar: [],
      json: { participants: [{ name: 'Zeynep' }, { name: 'Ben' }], messages: [{ sender_name: 'Zeynep', timestamp_ms: SIMDI - 5 * GUN }], thread_path: 'inbox/zeynep_17842000000000009' },
    },
  ];
  const r = A.analizEt(dosyalar, { kullaniciAdim: 'ben', simdiMs: SIMDI });
  assert.equal(r.hesaplar[0].sonDm.durum, 'var');
  assert.equal(r.hesaplar[0].sonDm.eslesme, 'slug');
});

test('dmSlugundanKullaniciAdi sondaki uzun kimliği atar, kısa sayıları korur', () => {
  assert.equal(A.dmSlugundanKullaniciAdi('ayse_yilmaz_17842000000000001'), 'ayse_yilmaz');
  assert.equal(A.dmSlugundanKullaniciAdi('mehmet.kaya_17842000000000002'), 'mehmet.kaya');
  assert.equal(A.dmSlugundanKullaniciAdi('john_2024'), 'john_2024');
});

test('işletme durumu: yalnızca açık alan ya da elle etiket', () => {
  const kayit = (u, ek) => Object.assign({ title: '', string_list_data: [{ value: u, timestamp: 1 }] }, ek || {});
  const dosyalar = [
    { yol: 'following.json', tur: 'takipEdilenler', kayitlar: [kayit('a'), kayit('b', { is_business: true }), kayit('c')], json: null },
    { yol: 'followers_1.json', tur: 'takipciler', kayitlar: [], json: null },
  ];
  const r = A.analizEt(dosyalar, { kullaniciAdim: 'ben', simdiMs: SIMDI, manuelIsletme: new Set(['c']) });
  const h = Object.fromEntries(r.hesaplar.map((x) => [x.norm, x]));
  assert.equal(h.a.isletme.durum, 'dogrulanamaz');
  assert.equal(h.b.isletme.durum, 'veriEvet');
  assert.equal(h.c.isletme.durum, 'manuelEvet');
  assert.deepEqual(r.listeler.isletme, ['b', 'c']);
});

test('ilişki türü', () => {
  const t = (o) => A.iliskiTuru(Object.assign({ takipEdiyorum: false, beniTakipEdiyor: false, istekGonderildi: false }, o));
  assert.equal(t({ takipEdiyorum: true, beniTakipEdiyor: true }), 'karsilikli');
  assert.equal(t({ takipEdiyorum: true }), 'takipEdiyorumBeniEtmiyor');
  assert.equal(t({ beniTakipEdiyor: true }), 'beniTakipEdiyorBenEtmiyorum');
  assert.equal(t({ istekGonderildi: true }), 'istekBekliyor');
  assert.equal(t({}), 'hicbiri');
  for (const tur of Object.keys(A.ILISKI_ETIKETLERI)) assert.equal(typeof A.MANUEL_TALIMATLAR[tur], 'string');
});

test('rastgele bekleme 10–15 sn aralığında ve crypto tabanlı', () => {
  const gorulen = new Set();
  for (let i = 0; i < 3000; i++) {
    const s = A.rastgeleSaniye(A.BEKLEME_MIN_SN, A.BEKLEME_MAX_SN);
    assert.ok(Number.isInteger(s) && s >= 10 && s <= 15, 'aralık dışı: ' + s);
    gorulen.add(s);
  }
  assert.equal(gorulen.size, 6);
});

test('kaynak kodda durum değiştiren ağ çağrısı yok', () => {
  const ham = fs.readFileSync(path.join(__dirname, '..', 'ig-manuel-asistan.js'), 'utf8');
  // Yorumlar çıkarılır (yasak kalıplar açıklama amaçlı yorumlarda geçebilir); yalnızca kod denetlenir.
  const kaynak = ham.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const yasakli = [/\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/, /sendBeacon/, /\beval\s*\(/, /new\s+Function/, /document\.cookie/, /csrftoken/i, /\bimport\s*\(/, /\.src\s*=/];
  for (const y of yasakli) assert.equal(y.test(kaynak), false, 'yasaklı kalıp bulundu: ' + y);
  // Tek dış URL kökü profil bağlantısıdır
  const urller = kaynak.match(/https?:\/\/[^\s'"`)]+/g) || [];
  for (const u of urller) assert.ok(u.startsWith('https://www.instagram.com/'), 'beklenmeyen URL: ' + u);
});
