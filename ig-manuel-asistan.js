/*
 * ig-manuel-asistan.js
 *
 * Instagram "Bilgilerini İndir" (JSON) arşivini tarayıcı içinde, yerel olarak analiz eden
 * ve seçilen hesaplar için MANUEL işlem kuyruğu gösteren tek dosyalık konsol aracı.
 *
 * Bu araç:
 *   - Yalnızca https://www.instagram.com/ üzerinde çalışır.
 *   - Hiçbir ağ isteği göndermez (fetch / XMLHttpRequest / WebSocket / beacon yoktur).
 *   - İçe aktarılan dosyaları yalnızca tarayıcı belleğinde okur; hiçbir sunucuya yollamaz.
 *   - Hiçbir hesabı takipten çıkarmaz, takipçi kaldırmaz, istek iptal etmez, mesaj göndermez.
 *   - Instagram arayüzündeki hiçbir düğmeye tıklamaz.
 *   - Parola, çerez, oturum kimliği, CSRF belirteci veya yetki başlığı okumaz.
 *   - Dış kütüphane, CDN, analitik veya telemetri kullanmaz.
 *   - eval, new Function, gizlenmiş kod veya dinamik betik yüklemesi içermez.
 *
 * Yapabildiği tek "dış" işlem: kullanıcı düğmeye bastığında
 *   https://www.instagram.com/<kullanıcı-adı>/
 * adresini yeni sekmede açmaktır. Bunun dışındaki her şey yerel listeleme ve kayıttır.
 *
 * Kullanım: Bu dosyanın tamamını kopyalayın, www.instagram.com açıkken tarayıcı
 * geliştirici konsoluna yapıştırın ve Enter'a basın.
 */
(function () {
  'use strict';

  // ===========================================================================
  // 1. Sabitler
  // ===========================================================================

  const SURUM = '0.1.0';
  const HEDEF_HOST = 'www.instagram.com';
  const HOST_ID = 'ig-manuel-asistan-host';
  const STORAGE_KEY = 'igManuelAsistan.v1.durum';

  const GUN_MS = 24 * 60 * 60 * 1000;
  const DM_ESIK_GUN = 365;
  const BEKLEME_MIN_SN = 10;
  const BEKLEME_MAX_SN = 15;

  const NODE_ORTAMI = typeof window === 'undefined' || typeof document === 'undefined';

  const UYARI_OTOMATIK_YOK =
    'Bu araç hiçbir hesabı otomatik olarak takipten çıkarmaz veya takipçi kaldırmaz.';
  const UYARI_VERI_ESKI =
    'Dışa aktarılan Instagram verisi güncel olmayabilir; listeler arşivin alındığı anı yansıtır.';
  const UYARI_KISITLAMA =
    'Manuel işlem yapmak Instagram kısıtlaması olasılığını sıfıra indirmez. Bu araç hesap güvenliği garantisi vermez.';
  const UYARI_DOGRULAMA_YOK =
    'Araç, Instagram üzerinde bir işlemi gerçekten yapıp yapmadığınızı doğrulayamaz. "Tamamlandı" işareti yalnızca yerel bir kayıttır.';

  // ===========================================================================
  // 2. Saf yardımcılar (DOM'a ve ağa dokunmaz)
  // ===========================================================================

  // Instagram JSON dışa aktarımı, UTF-8 baytlarını Latin-1 karakterleri gibi kaçırır
  // ("Ã¼" → "ü"). Bu fonksiyon yalnızca metni düzeltir; başarısız olursa
  // girdiyi olduğu gibi döndürür.
  function mojibakeDuzelt(metin) {
    if (typeof metin !== 'string' || metin.length === 0) return metin;
    let yuksekVar = false;
    for (let i = 0; i < metin.length; i++) {
      const kod = metin.charCodeAt(i);
      if (kod > 0xff) return metin; // zaten gerçek Unicode
      if (kod >= 0x80) yuksekVar = true;
    }
    if (!yuksekVar) return metin;
    try {
      const baytlar = new Uint8Array(metin.length);
      for (let i = 0; i < metin.length; i++) baytlar[i] = metin.charCodeAt(i);
      return new TextDecoder('utf-8', { fatal: true }).decode(baytlar);
    } catch (_hata) {
      return metin;
    }
  }

  // Dosya yolunu karşılaştırma için sadeleştirir: ters bölü → bölü, küçük harf.
  function yolNormalize(yol) {
    return String(yol || '').replace(/\\/g, '/').toLowerCase();
  }

  function dosyaAdi(yol) {
    const parcalar = yolNormalize(yol).split('/');
    return parcalar[parcalar.length - 1] || '';
  }

  function dizimi(x) {
    return Array.isArray(x);
  }

  function nesneMi(x) {
    return x !== null && typeof x === 'object' && !Array.isArray(x);
  }

  // Instagram ilişki dosyalarındaki tek bir kaydın beklenen biçimde olup olmadığını
  // kontrol eder: { title?, string_list_data: [{ href?, value?, timestamp? }] }
  function iliskiKaydiMi(kayit) {
    if (!nesneMi(kayit)) return false;
    if (!dizimi(kayit.string_list_data)) return false;
    if (kayit.string_list_data.length === 0) return typeof kayit.title === 'string';
    const ilk = kayit.string_list_data[0];
    return nesneMi(ilk) && (typeof ilk.value === 'string' || typeof ilk.href === 'string');
  }

  function iliskiListesiMi(dizi) {
    if (!dizimi(dizi)) return false;
    if (dizi.length === 0) return true; // boş liste de geçerli (ör. hiç takipçi yok)
    // İlk birkaç kaydı örnekle; tamamını taramak gerekmiyor.
    const ornek = dizi.slice(0, 5);
    return ornek.every(iliskiKaydiMi);
  }

  // DM iş parçacığı dosyası: { participants: [{name}], messages: [{sender_name, timestamp_ms}] }
  function dmDosyasiMi(json) {
    if (!nesneMi(json)) return false;
    if (!dizimi(json.participants) || !dizimi(json.messages)) return false;
    if (json.messages.length === 0) return true;
    const ilk = json.messages[0];
    return nesneMi(ilk) && (typeof ilk.timestamp_ms === 'number' || typeof ilk.sender_name === 'string');
  }

  // ===========================================================================
  // 3. Veri seti algılama (hem yol hem JSON yapısı; dosya adına tek başına güvenilmez)
  // ===========================================================================

  // Bilinen ilişki anahtarları → veri seti türü
  const ILISKI_ANAHTARLARI = {
    relationships_followers: 'takipciler',
    relationships_following: 'takipEdilenler',
    relationships_follow_requests_sent: 'istekGonderilen',
    relationships_follow_requests_received: 'istekGelen',
    relationships_permanent_follow_requests: 'iliskiDiger',
    relationships_close_friends: 'iliskiDiger',
    relationships_blocked_users: 'iliskiDiger',
    relationships_restricted_users: 'iliskiDiger',
    relationships_hide_stories_from: 'iliskiDiger',
    relationships_unfollowed_users: 'iliskiDiger',
    relationships_dismissed_suggested_users: 'iliskiDiger',
  };

  const VERI_SETI_ETIKETLERI = {
    takipciler: 'Takipçiler',
    takipEdilenler: 'Takip ettiklerim',
    istekGonderilen: 'Gönderdiğim bekleyen takip istekleri',
    istekGelen: 'Bana gelen takip istekleri (kullanılmaz, yalnızca ayırt edilir)',
    dm: 'Direkt mesaj konuşması',
    kisiselBilgi: 'Kişisel bilgi (kullanıcı adı önerisi için)',
    iliskiDiger: 'Diğer ilişki dosyası (kullanılmaz)',
    bilinmeyen: 'Tanınmadı',
  };

  const GEREKLI_VERI_SETLERI = [
    { tur: 'takipciler', zorunlu: true, aciklama: 'followers_*.json benzeri takipçi listesi' },
    { tur: 'takipEdilenler', zorunlu: true, aciklama: 'following.json benzeri takip listesi' },
    { tur: 'istekGonderilen', zorunlu: false, aciklama: 'pending_follow_requests.json benzeri gönderilen istekler' },
    { tur: 'dm', zorunlu: false, aciklama: 'messages/inbox/*/message_*.json konuşmaları' },
  ];

  // Bir dosyanın yolu ve içeriğinden veri seti türünü ve kayıt dizisini çıkarır.
  // Dönüş: { tur, kayitlar (dizi ya da null), not }
  function veriSetiTuruBul(yol, json) {
    const y = yolNormalize(yol);
    const ad = dosyaAdi(yol);

    // 1) Nesne kökünde bilinen ilişki anahtarı var mı?
    if (nesneMi(json)) {
      for (const [anahtar, tur] of Object.entries(ILISKI_ANAHTARLARI)) {
        if (anahtar in json && iliskiListesiMi(json[anahtar])) {
          return { tur, kayitlar: json[anahtar], not: 'Anahtar: ' + anahtar };
        }
      }
      // DM iş parçacığı
      if (dmDosyasiMi(json)) {
        if (y.includes('message_requests')) {
          return { tur: 'iliskiDiger', kayitlar: null, not: 'Mesaj isteği klasörü; gelen kutusu değil, kullanılmaz' };
        }
        const gelenKutusu = y.includes('/inbox/') || y.startsWith('inbox/');
        return { tur: 'dm', kayitlar: json.messages, not: gelenKutusu ? 'inbox altında' : 'inbox yolu doğrulanamadı, yapıya göre tanındı' };
      }
      // Kişisel bilgi
      if (dizimi(json.profile_user) && json.profile_user.some((k) => nesneMi(k) && nesneMi(k.string_map_data))) {
        return { tur: 'kisiselBilgi', kayitlar: json.profile_user, not: 'profile_user' };
      }
    }

    // 2) Kök dizi: yeni biçimde followers_N.json böyle gelir. Yol ipucuyla ayırt edilir.
    if (dizimi(json) && iliskiListesiMi(json)) {
      if (/followers/.test(ad) || /followers/.test(y)) {
        return { tur: 'takipciler', kayitlar: json, not: 'Kök dizi + yolda "followers"' };
      }
      if (/following/.test(ad)) {
        return { tur: 'takipEdilenler', kayitlar: json, not: 'Kök dizi + adında "following"' };
      }
      if (/pending_follow_requests|follow_requests_sent/.test(ad)) {
        return { tur: 'istekGonderilen', kayitlar: json, not: 'Kök dizi + adında "pending/sent"' };
      }
      if (/received/.test(ad)) {
        return { tur: 'istekGelen', kayitlar: json, not: 'Kök dizi + adında "received"' };
      }
      return { tur: 'bilinmeyen', kayitlar: null, not: 'İlişki listesi yapısında ama hangisi olduğu yoldan anlaşılamadı' };
    }

    return { tur: 'bilinmeyen', kayitlar: null, not: 'Bilinen bir Instagram veri yapısıyla eşleşmedi' };
  }

  // Kişisel bilgi dosyasından kullanıcı adı önerisi çıkarır (anahtar adı dile göre değişebilir).
  function kullaniciAdiOnerisiBul(profileUser) {
    if (!dizimi(profileUser)) return null;
    for (const kayit of profileUser) {
      if (!nesneMi(kayit) || !nesneMi(kayit.string_map_data)) continue;
      for (const [anahtar, deger] of Object.entries(kayit.string_map_data)) {
        if (!nesneMi(deger)) continue;
        const a = mojibakeDuzelt(anahtar).toLowerCase();
        if (a === 'username' || a === 'kullanıcı adı' || a === 'kullanici adi') {
          if (typeof deger.value === 'string' && deger.value.trim()) return mojibakeDuzelt(deger.value.trim());
        }
        if (typeof deger.href === 'string') {
          const m = deger.href.match(/instagram\.com\/([A-Za-z0-9._]+)\/?$/);
          if (m) return m[1];
        }
      }
    }
    return null;
  }

  // Okunmuş dosya listesinden özet çıkarır: hangi türden kaç dosya var, hangileri eksik.
  function veriSetleriniOzetle(dosyalar) {
    const sayim = {};
    for (const d of dosyalar) {
      if (!d.tur) continue;
      sayim[d.tur] = (sayim[d.tur] || 0) + 1;
    }
    const eksikler = GEREKLI_VERI_SETLERI.filter((g) => !sayim[g.tur]);
    return { sayim, eksikler };
  }

  // ===========================================================================
  // 4. Kullanıcı adı normalizasyonu ve hesap modeli
  // ===========================================================================

  // Profil URL'sinden kullanıcı adı çıkarır; profil olmayan yollar (p/, reel/, explore/) null döner.
  const PROFIL_OLMAYAN_YOLLAR = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'accounts', 'direct', '_u', 'tv']);
  function kullaniciAdiUrldenCikar(href) {
    if (typeof href !== 'string') return null;
    const m = href.trim().match(/^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([^/?#]+)\/?(?:[?#].*)?$/i);
    if (!m) return null;
    const parca = m[1].replace(/^@/, '');
    if (PROFIL_OLMAYAN_YOLLAR.has(parca.toLowerCase())) return null;
    return parca;
  }

  // Karşılaştırma için: boşluk kırp, baştaki @ kaldır, URL ise kullanıcı adını çıkar, küçük harfe çevir.
  // Görüntüleme için orijinal değer ayrıca saklanır (bkz. iliskiKaydiniCoz).
  function normalizeKullaniciAdi(girdi) {
    if (typeof girdi !== 'string') return '';
    let s = girdi.trim();
    if (/instagram\.com\//i.test(s)) {
      const u = kullaniciAdiUrldenCikar(s);
      if (u) s = u;
    }
    s = s.replace(/^@+/, '').trim();
    // Türkçe "İ" gibi harfler için toLocaleLowerCase yerine ASCII davranışı yeterli;
    // Instagram kullanıcı adları yalnızca a-z, 0-9, nokta ve alt çizgi içerir.
    return s.toLowerCase();
  }

  // İşletme durumu: dışa aktarımda güvenilir bir alan varsa yalnızca onu kullanır.
  // Kullanıcı adı, ad, biyografi veya takipçi sayısından TAHMİN YAPMAZ.
  function isletmeAlaniOku(kayit) {
    const adaylar = [kayit];
    if (dizimi(kayit.string_list_data) && kayit.string_list_data[0]) adaylar.push(kayit.string_list_data[0]);
    for (const n of adaylar) {
      if (!nesneMi(n)) continue;
      if (n.is_business === true || n.is_professional === true || n.is_business_account === true) {
        return { deger: true, kaynak: 'is_business alanı' };
      }
      if (typeof n.account_type === 'string' && /business|professional|creator/i.test(n.account_type)) {
        return { deger: true, kaynak: 'account_type alanı: ' + n.account_type };
      }
    }
    return null;
  }

  // Tek bir ilişki kaydını çözer: { kullaniciAdi, norm, zamanMs, isletme }
  function iliskiKaydiniCoz(kayit) {
    if (!nesneMi(kayit)) return null;
    const sld = dizimi(kayit.string_list_data) && kayit.string_list_data.length > 0 ? kayit.string_list_data[0] : null;
    let orijinal = null;
    if (sld && typeof sld.value === 'string' && sld.value.trim()) orijinal = sld.value.trim();
    else if (typeof kayit.title === 'string' && kayit.title.trim()) orijinal = kayit.title.trim();
    else if (sld && typeof sld.href === 'string') orijinal = kullaniciAdiUrldenCikar(sld.href);
    if (!orijinal) return null;
    orijinal = mojibakeDuzelt(orijinal);
    const norm = normalizeKullaniciAdi(orijinal);
    if (!norm) return null;
    let zamanMs = null;
    if (sld && typeof sld.timestamp === 'number') {
      // Dışa aktarımda saniye cinsinden; 10^12 üstü zaten milisaniyedir.
      zamanMs = sld.timestamp > 1e12 ? sld.timestamp : sld.timestamp * 1000;
    }
    return { kullaniciAdi: orijinal.replace(/^@/, ''), norm, zamanMs, isletme: isletmeAlaniOku(kayit) };
  }

  function yeniHesap(norm, kullaniciAdi) {
    return {
      norm,
      kullaniciAdi, // görüntüleme için orijinal yazım
      takipEdiyorum: false,
      beniTakipEdiyor: false,
      istekGonderildi: false,
      takipTarihiMs: null, // benim onu takip etmeye başladığım zaman (varsa)
      takipciTarihiMs: null, // onun beni takip etmeye başladığı zaman (varsa)
      istekTarihiMs: null,
      kaynakDosyalar: [],
      isletmeVeri: null, // { deger: true, kaynak } yalnızca dışa aktarımda alan varsa
      sonDm: { durum: 'arsivYok', zamanMs: null, kaynak: null, eslesme: null },
    };
  }

  // Okunmuş dosyalardan tekilleştirilmiş hesap haritası üretir (Map<norm, hesap>).
  function hesaplariBirlestir(dosyalar, kullaniciAdimNorm) {
    const hesaplar = new Map();
    const sayilar = { takipciler: 0, takipEdilenler: 0, istekGonderilen: 0, gecersizKayit: 0, kendisiAtlandi: 0 };

    function al(coz, kaynak) {
      let h = hesaplar.get(coz.norm);
      if (!h) {
        h = yeniHesap(coz.norm, coz.kullaniciAdi);
        hesaplar.set(coz.norm, h);
      }
      if (!h.kaynakDosyalar.includes(kaynak)) h.kaynakDosyalar.push(kaynak);
      if (coz.isletme && !h.isletmeVeri) h.isletmeVeri = coz.isletme;
      return h;
    }

    for (const d of dosyalar) {
      if (!['takipciler', 'takipEdilenler', 'istekGonderilen'].includes(d.tur)) continue;
      if (!dizimi(d.kayitlar)) continue;
      for (const kayit of d.kayitlar) {
        const coz = iliskiKaydiniCoz(kayit);
        if (!coz) {
          sayilar.gecersizKayit++;
          continue;
        }
        if (kullaniciAdimNorm && coz.norm === kullaniciAdimNorm) {
          sayilar.kendisiAtlandi++;
          continue;
        }
        const h = al(coz, d.yol);
        if (d.tur === 'takipciler') {
          h.beniTakipEdiyor = true;
          if (coz.zamanMs && (!h.takipciTarihiMs || coz.zamanMs > h.takipciTarihiMs)) h.takipciTarihiMs = coz.zamanMs;
          sayilar.takipciler++;
        } else if (d.tur === 'takipEdilenler') {
          h.takipEdiyorum = true;
          if (coz.zamanMs && (!h.takipTarihiMs || coz.zamanMs > h.takipTarihiMs)) h.takipTarihiMs = coz.zamanMs;
          sayilar.takipEdilenler++;
        } else if (d.tur === 'istekGonderilen') {
          h.istekGonderildi = true;
          if (coz.zamanMs && (!h.istekTarihiMs || coz.zamanMs > h.istekTarihiMs)) h.istekTarihiMs = coz.zamanMs;
          sayilar.istekGonderilen++;
        }
      }
    }
    return { hesaplar, sayilar };
  }

  // İlişki durumu etiketi (bir hesap birden fazla listede görünebilir; bu, satırda gösterilen özet).
  const ILISKI_ETIKETLERI = {
    karsilikli: 'Karşılıklı takip',
    takipEdiyorumBeniEtmiyor: 'Takip ediyorum, beni takip etmiyor',
    beniTakipEdiyorBenEtmiyorum: 'Beni takip ediyor, ben takip etmiyorum',
    istekBekliyor: 'Takip isteğim bekliyor',
    hicbiri: 'İlişki yok',
  };

  function iliskiTuru(h) {
    if (h.takipEdiyorum && h.beniTakipEdiyor) return 'karsilikli';
    if (h.takipEdiyorum) return 'takipEdiyorumBeniEtmiyor';
    if (h.beniTakipEdiyor) return 'beniTakipEdiyorBenEtmiyorum';
    if (h.istekGonderildi) return 'istekBekliyor';
    return 'hicbiri';
  }

  // ===========================================================================
  // 5. Direkt mesaj (DM) çözümleme
  //
  // Instagram, konuşmaları messages/inbox/<slug>/message_N.json olarak dışa aktarır.
  // <slug> genellikle karşı tarafın kullanıcı adı + "_" + uzun sayısal kimliktir
  // (ör. "ayse_17842123456789012"). Katılımcı adları ise görünen ad'dır, kullanıcı adı değil.
  // Bu yüzden eşleştirme iki aşamalıdır: önce klasör slug'ı (güvenilir), sonra görünen ad'ın
  // kullanıcı adıyla birebir eşleşmesi (daha zayıf; ayrıca işaretlenir).
  // ===========================================================================

  // "ayse_17842123456789012" → "ayse". Sondaki uzun sayısal kimlik (8+ hane) atılır.
  function dmSlugundanKullaniciAdi(slug) {
    if (typeof slug !== 'string') return null;
    const s = slug.trim();
    if (!s) return null;
    return normalizeKullaniciAdi(s.replace(/_\d{8,}$/, ''));
  }

  // Dosya yolundan ya da thread_path alanından konuşma slug'ını bulur.
  function dmSlugBul(yol, json) {
    const y = yolNormalize(yol);
    const parcalar = y.split('/');
    const i = parcalar.lastIndexOf('inbox');
    if (i >= 0 && parcalar.length > i + 1) return parcalar[i + 1];
    if (nesneMi(json) && typeof json.thread_path === 'string') {
      const tp = yolNormalize(json.thread_path).split('/');
      return tp[tp.length - 1] || null;
    }
    // Yol yalnızca dosya adı ise (çoklu dosya seçimi) slug bilinmez.
    return null;
  }

  function dmSonZaman(messages) {
    let son = null;
    if (!dizimi(messages)) return null;
    for (const m of messages) {
      if (nesneMi(m) && typeof m.timestamp_ms === 'number' && (son === null || m.timestamp_ms > son)) son = m.timestamp_ms;
    }
    return son;
  }

  // Tüm DM dosyalarını konuşma bazında gruplayıp hesaplara eşler.
  // Dönüş: { arsivVar, konusmaSayisi, birebirSayisi, grupSayisi, eslesmeyenBirebir, eslesmeler: Map<norm, {zamanMs, kaynak, eslesme}> }
  function dmKonusmalariniIsle(dosyalar, hesaplar, kullaniciAdimNorm, grupDahil) {
    const dmDosyalari = dosyalar.filter((d) => d.tur === 'dm');
    const sonuc = {
      arsivVar: dmDosyalari.length > 0,
      konusmaSayisi: 0,
      birebirSayisi: 0,
      grupSayisi: 0,
      eslesmeyenBirebir: 0,
      eslesmeler: new Map(),
    };
    if (!sonuc.arsivVar) return sonuc;

    // Aynı konuşmanın parçalarını (message_1, message_2, …) birleştir.
    const konusmalar = new Map(); // anahtar: slug ya da yol
    for (const d of dmDosyalari) {
      const slug = dmSlugBul(d.yol, d.json) || ('__yol__' + yolNormalize(d.yol));
      let k = konusmalar.get(slug);
      if (!k) {
        k = { slug, katilimcilar: [], sonMs: null, kaynaklar: [] };
        konusmalar.set(slug, k);
      }
      if (dizimi(d.json.participants)) {
        for (const p of d.json.participants) {
          const ad = nesneMi(p) && typeof p.name === 'string' ? mojibakeDuzelt(p.name) : null;
          if (ad && !k.katilimcilar.includes(ad)) k.katilimcilar.push(ad);
        }
      }
      const son = dmSonZaman(d.json.messages);
      if (son !== null && (k.sonMs === null || son > k.sonMs)) k.sonMs = son;
      k.kaynaklar.push(d.yol);
    }

    function eslestir(norm, k, eslesme) {
      if (!hesaplar.has(norm)) return false;
      const eski = sonuc.eslesmeler.get(norm);
      if (!eski || (k.sonMs !== null && (eski.zamanMs === null || k.sonMs > eski.zamanMs))) {
        sonuc.eslesmeler.set(norm, { zamanMs: k.sonMs, kaynak: k.kaynaklar[0], eslesme });
      }
      return true;
    }

    for (const k of konusmalar.values()) {
      sonuc.konusmaSayisi++;
      const birebir = k.katilimcilar.length <= 2;
      if (!birebir) {
        sonuc.grupSayisi++;
        if (!grupDahil) continue;
        // Grup konuşması yalnızca isteğe bağlı olarak ve görünen ad eşleşmesiyle sayılır.
        for (const ad of k.katilimcilar) {
          const n = normalizeKullaniciAdi(ad);
          if (n && n !== kullaniciAdimNorm) eslestir(n, k, 'grup-ad');
        }
        continue;
      }
      sonuc.birebirSayisi++;
      let eslesti = false;
      if (!k.slug.startsWith('__yol__')) {
        const n = dmSlugundanKullaniciAdi(k.slug);
        if (n && n !== kullaniciAdimNorm) eslesti = eslestir(n, k, 'slug');
      }
      if (!eslesti) {
        for (const ad of k.katilimcilar) {
          const n = normalizeKullaniciAdi(ad);
          if (n && n !== kullaniciAdimNorm && eslestir(n, k, 'ad')) {
            eslesti = true;
            break;
          }
        }
      }
      if (!eslesti) sonuc.eslesmeyenBirebir++;
    }
    return sonuc;
  }

  // Her hesabın sonDm alanını doldurur. Durumlar:
  //   'var'      → son 365 gün içinde birebir mesaj var
  //   'eski'     → son mesaj 365 günden eski
  //   'yok'      → içe aktarılan dosyalarda bu hesapla birebir konuşma bulunamadı
  //   'arsivYok' → hiç DM dosyası yüklenmedi (arşiv eksik ya da hiç seçilmedi)
  function sonDmUygula(hesaplar, dmSonuc, simdiMs) {
    const esikMs = simdiMs - DM_ESIK_GUN * GUN_MS;
    for (const h of hesaplar.values()) {
      if (!dmSonuc.arsivVar) {
        h.sonDm = { durum: 'arsivYok', zamanMs: null, kaynak: null, eslesme: null };
        continue;
      }
      const e = dmSonuc.eslesmeler.get(h.norm);
      if (!e) {
        h.sonDm = { durum: 'yok', zamanMs: null, kaynak: null, eslesme: null };
        continue;
      }
      const durumu = e.zamanMs !== null && e.zamanMs >= esikMs ? 'var' : 'eski';
      h.sonDm = { durum: durumu, zamanMs: e.zamanMs, kaynak: e.kaynak, eslesme: e.eslesme };
    }
  }

  const DM_DURUM_ETIKETLERI = {
    var: 'Son 1 yıl içinde DM var',
    eski: 'Son DM 365 günden eski',
    yok: 'İçe aktarılan dosyalarda birebir konuşma bulunamadı',
    arsivYok: 'Mesaj arşivi yüklenmedi / eksik',
  };

  // ---------------------------------------------------------------------------
  // Liste tanımları: her liste, hesap için bir yüklem (predicate).
  // ---------------------------------------------------------------------------

  const LISTE_TANIMLARI = [
    {
      ad: 'takipEtmeyenler',
      baslik: 'Takip ettiklerim ama beni takip etmeyenler',
      aciklama: 'Takip ettiklerim − takipçilerim.',
      yuklem: (h) => h.takipEdiyorum && !h.beniTakipEdiyor,
    },
    {
      ad: 'dmYok',
      baslik: 'Son 1 yıldır DM etkileşimi olmayanlar',
      aciklama:
        'Takip ettiğim ve son 365 günde birebir (grup dışı) DM alışverişi bulunmayan hesaplar. ' +
        '"Konuşma bulunamadı" ve "arşiv eksik" durumları hiç yazışılmadığının kanıtı DEĞİLDİR.',
      yuklem: (h) => h.takipEdiyorum && h.sonDm.durum !== 'var',
    },
    {
      ad: 'isletme',
      baslik: 'İşletme hesapları',
      aciklama:
        'Dışa aktarılan veride güvenilir bir işletme alanı bulunmadığından bu durum çevrimdışı doğrulanamaz. ' +
        'Yalnızca elle işaretlediğiniz hesaplar (ve veri açıkça belirtiyorsa) burada listelenir.',
      yuklem: (h) => h.isletme.durum !== 'dogrulanamaz',
    },
    {
      ad: 'takipEtmediklerim',
      baslik: 'Beni takip eden ama benim takip etmediklerim',
      aciklama: 'Takipçilerim − takip ettiklerim.',
      yuklem: (h) => h.beniTakipEdiyor && !h.takipEdiyorum,
    },
    {
      ad: 'karsilikli',
      baslik: 'Karşılıklı takipleştiklerim',
      aciklama: 'Takipçilerim ∩ takip ettiklerim.',
      yuklem: (h) => h.beniTakipEdiyor && h.takipEdiyorum,
    },
    {
      ad: 'istekler',
      baslik: 'Takip isteği gönderdiklerim',
      aciklama:
        'Arşivdeki "gönderilen bekleyen istekler" dosyasından. Gelen istekler bu listeye alınmaz. ' +
        'Eski bir arşiv, isteğin güncel durumunu (kabul/iptal) yansıtmayabilir.',
      yuklem: (h) => h.istekGonderildi,
    },
  ];

  function isletmeDurumu(h, manuelIsletme) {
    if (h.isletmeVeri && h.isletmeVeri.deger === true) return { durum: 'veriEvet', kaynak: h.isletmeVeri.kaynak };
    if (manuelIsletme && manuelIsletme.has(h.norm)) return { durum: 'manuelEvet', kaynak: 'Elle işaretlendi' };
    return { durum: 'dogrulanamaz', kaynak: 'Çevrimdışı doğrulanamaz' };
  }

  // Tüm analiz: saf fonksiyon. Girdi: okunmuş dosyalar + seçenekler. Çıktı: hesaplar ve listeler.
  // secenekler: { kullaniciAdim, simdiMs, grupDahil, manuelIsletme:Set }
  function analizEt(dosyalar, secenekler) {
    const s = secenekler || {};
    const simdiMs = typeof s.simdiMs === 'number' ? s.simdiMs : Date.now();
    const kullaniciAdimNorm = normalizeKullaniciAdi(s.kullaniciAdim || '');
    const manuelIsletme = s.manuelIsletme instanceof Set ? s.manuelIsletme : new Set();

    const { hesaplar, sayilar } = hesaplariBirlestir(dosyalar, kullaniciAdimNorm);
    const dm = dmKonusmalariniIsle(dosyalar, hesaplar, kullaniciAdimNorm, !!s.grupDahil);
    sonDmUygula(hesaplar, dm, simdiMs);

    const dizi = [];
    for (const h of hesaplar.values()) {
      h.iliski = iliskiTuru(h);
      h.isletme = isletmeDurumu(h, manuelIsletme);
      dizi.push(h);
    }
    dizi.sort((a, b) => a.norm.localeCompare(b.norm));

    const listeler = {};
    for (const t of LISTE_TANIMLARI) listeler[t.ad] = dizi.filter(t.yuklem).map((h) => h.norm);

    const uyarilar = [];
    if (sayilar.gecersizKayit > 0) uyarilar.push(sayilar.gecersizKayit + ' kayıt kullanıcı adı çıkarılamadığı için atlandı.');
    if (sayilar.kendisiAtlandi > 0) uyarilar.push('Kendi kullanıcı adınız listelerden çıkarıldı.');
    if (!dm.arsivVar) {
      uyarilar.push('Mesaj arşivi yüklenmedi; DM sekmesindeki tüm hesaplar "arşiv eksik" durumundadır. Bu, hiç yazışılmadığı anlamına gelmez.');
    } else {
      if (dm.eslesmeyenBirebir > 0) {
        uyarilar.push(dm.eslesmeyenBirebir + ' birebir konuşma hiçbir hesapla eşleştirilemedi (silinmiş hesap, ad değişikliği veya slug farkı olabilir).');
      }
      if (dm.grupSayisi > 0 && !s.grupDahil) uyarilar.push(dm.grupSayisi + ' grup konuşması varsayılan olarak dışarıda bırakıldı.');
    }

    const dmOzet = {
      arsivVar: dm.arsivVar,
      konusmaSayisi: dm.konusmaSayisi,
      birebirSayisi: dm.birebirSayisi,
      grupSayisi: dm.grupSayisi,
      eslesmeyenBirebir: dm.eslesmeyenBirebir,
      eslesenHesap: dm.eslesmeler.size,
    };

    return { hesaplar: dizi, listeler, sayilar, uyarilar, simdiMs, kullaniciAdimNorm, dm: dmOzet };
  }

  // ===========================================================================
  // Dışa verilen saf API (test ve denetim için; hiçbir fonksiyon durum değiştirmez)
  // ===========================================================================

  const API = Object.freeze({
    SURUM,
    STORAGE_KEY,
    DM_ESIK_GUN,
    BEKLEME_MIN_SN,
    BEKLEME_MAX_SN,
    mojibakeDuzelt,
    yolNormalize,
    veriSetiTuruBul,
    kullaniciAdiOnerisiBul,
    veriSetleriniOzetle,
    VERI_SETI_ETIKETLERI,
    GEREKLI_VERI_SETLERI,
    normalizeKullaniciAdi,
    kullaniciAdiUrldenCikar,
    iliskiKaydiniCoz,
    hesaplariBirlestir,
    iliskiTuru,
    ILISKI_ETIKETLERI,
    LISTE_TANIMLARI,
    analizEt,
    dmSlugundanKullaniciAdi,
    dmKonusmalariniIsle,
    DM_DURUM_ETIKETLERI,
    // [[API: fonksiyonlar]]
  });

  // Node ortamında (testler) yalnızca saf fonksiyonlar dışa verilir; arayüz kurulmaz.
  if (NODE_ORTAMI) {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = API;
    }
    return;
  }

  // ===========================================================================
  // Ortam kontrolü: yalnızca www.instagram.com üzerinde çalışır
  // ===========================================================================

  if (window.location.hostname !== HEDEF_HOST) {
    console.warn(
      '[ig-manuel-asistan] Bu araç yalnızca https://www.instagram.com/ üzerinde çalışır. ' +
        'Şu anki alan adı: ' + window.location.hostname + '. Hiçbir şey yapılmadı.'
    );
    return;
  }

  // Aynı sayfada ikinci kez çalıştırılırsa eski paneli kaldırıp yenisini kurar.
  const eskiHost = document.getElementById(HOST_ID);
  if (eskiHost) {
    eskiHost.remove();
  }

  // ===========================================================================
  // DOM yardımcıları (innerHTML kullanılmaz; tüm metinler textContent ile yazılır)
  // ===========================================================================

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'disabled' || k === 'checked' || k === 'multiple' || k === 'selected') node[k] = !!v;
        else node.setAttribute(k, String(v));
      }
    }
    if (children) {
      for (const c of Array.isArray(children) ? children : [children]) {
        if (c === null || c === undefined || c === false) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return node;
  }

  function temizle(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // ===========================================================================
  // Stil (Shadow DOM içinde izole; Instagram sayfasının stiline dokunmaz)
  // ===========================================================================

  const STIL = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel {
      --bg: #ffffff;
      --bg2: #f5f6f8;
      --fg: #111418;
      --muted: #5f6b7a;
      --border: #d9dee5;
      --accent: #0a66c2;
      --accent-fg: #ffffff;
      --danger: #c62828;
      --ok: #2e7d32;
      --warn-bg: #fff6d6;
      --warn-fg: #6b4e00;
      --shadow: 0 8px 32px rgba(0,0,0,.25);
      position: fixed;
      top: 0;
      right: 0;
      width: min(760px, 100vw);
      height: 100vh;
      display: flex;
      flex-direction: column;
      background: var(--bg);
      color: var(--fg);
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      box-shadow: var(--shadow);
      border-left: 1px solid var(--border);
    }
    .panel.kucultulmus { height: auto; width: auto; }
    .panel.kucultulmus > :not(.baslik) { display: none; }
    .baslik {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      background: var(--bg2);
    }
    .baslik h1 { font-size: 15px; margin: 0; flex: 1; font-weight: 600; }
    .baslik .surum { color: var(--muted); font-size: 12px; margin-left: 6px; font-weight: 400; }
    button {
      font: inherit;
      color: var(--fg);
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 5px 10px;
      cursor: pointer;
    }
    button:hover:not(:disabled) { background: var(--bg2); }
    button:disabled { opacity: .5; cursor: not-allowed; }
    button.birincil { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
    button.tehlike { color: var(--danger); border-color: var(--danger); }
    button.kucuk { padding: 2px 7px; font-size: 12px; }
    .uyari {
      margin: 10px 14px 0;
      padding: 8px 12px;
      background: var(--warn-bg);
      color: var(--warn-fg);
      border-radius: 6px;
      font-size: 13px;
    }
    .uyari p { margin: 2px 0; }
    .gezinti {
      display: flex;
      gap: 4px;
      padding: 10px 14px 0;
      border-bottom: 1px solid var(--border);
      flex-wrap: wrap;
    }
    .gezinti button {
      border-bottom: none;
      border-radius: 6px 6px 0 0;
      background: var(--bg2);
    }
    .gezinti button.etkin { background: var(--bg); font-weight: 600; border-bottom: 1px solid var(--bg); margin-bottom: -1px; }
    .icerik { flex: 1; overflow: auto; padding: 14px; }
    .icerik h2 { font-size: 15px; margin: 0 0 8px; }
    .icerik h3 { font-size: 14px; margin: 14px 0 6px; }
    .icerik p { margin: 4px 0; }
    .sessiz { color: var(--muted); font-size: 13px; }
    .hata { color: var(--danger); }
    .basarili { color: var(--ok); }
    .kart { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin: 8px 0; background: var(--bg); }
    .satir { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 6px 0; }
    input[type="text"], input[type="search"], select, textarea {
      font: inherit;
      color: var(--fg);
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 5px 8px;
    }
    ul.liste { margin: 4px 0; padding-left: 18px; }
    ul.liste li { margin: 2px 0; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: var(--bg2); padding: 1px 4px; border-radius: 4px; }
    .altbilgi { padding: 8px 14px; border-top: 1px solid var(--border); font-size: 12px; color: var(--muted); }
    .tablo-kap { overflow-x: auto; max-width: 100%; }
    table.tablo { border-collapse: collapse; width: 100%; font-size: 13px; }
    table.tablo th, table.tablo td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
    table.tablo th { background: var(--bg2); position: sticky; top: 0; }
    table.tablo a { color: var(--accent); text-decoration: none; }
    table.tablo a:hover { text-decoration: underline; }
    .alt-sekmeler { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
    .alt-sekmeler button.etkin { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
    input[type="search"] { min-width: 160px; }
    label.satir { cursor: pointer; }
    /* [[STİL: ek]] */
  `;

  // ===========================================================================
  // Uygulama durumu (yalnızca bu sekmede, bellekte)
  // ===========================================================================

  const durum = {
    goruntu: 'veri', // veri | listeler | kuyruk | kayit | bilgi
    kucultulmus: false,
    kuyruk: null, // etkin kuyruk varsa nesne (ileriki bölümlerde doldurulur)
    dosyalar: [], // { yol, ad, boyut, json, tur, kayitlar, kayitSayisi, not }
    atlananDosyaSayisi: 0,
    okumaHatalari: [],
    okunuyor: false,
    kullaniciAdiOnerisi: null,
    kullaniciAdim: '',
    kullaniciAdiOnaylandi: false,
    analiz: null, // analizEt() sonucu
    grupDahil: false, // DM hesabında grup konuşmaları da sayılsın mı (varsayılan: hayır)
    secilenler: new Set(), // seçili hesapların norm adları (sekmeler arası ortak)
    manuelIsletme: new Set(), // elle "işletme" olarak işaretlenen norm adlar
    liste: {
      sekme: 'takipEtmeyenler',
      arama: '',
      siralama: { alan: 'kullaniciAdi', yon: 1 },
      filtreler: { dm: 'hepsi', isletme: 'hepsi', kaynak: 'hepsi', secili: 'hepsi' },
      sayfa: 1,
    },
    // [[DURUM: alanlar]]
  };

  // Analizi (yeniden) çalıştırır. Saf analizEt fonksiyonunu bellekteki dosyalarla çağırır.
  function analiziCalistir() {
    if (!durum.kullaniciAdiOnaylandi) return;
    durum.analiz = analizEt(durum.dosyalar, {
      kullaniciAdim: durum.kullaniciAdim,
      simdiMs: Date.now(),
      grupDahil: durum.grupDahil,
      manuelIsletme: durum.manuelIsletme,
      // [[ANALİZ ÇAĞRISI: seçenekler]]
    });
  }

  // ===========================================================================
  // Yerel dosya okuma
  // Bu bölüm AĞ İSTEĞİ YAPMAZ. Dosyalar, kullanıcının seçtiği yerel dosya nesnelerinden
  // File.text() ile tarayıcı belleğine okunur; hiçbir yere gönderilmez.
  // ===========================================================================

  async function dosyalariOku(dosyaListesi) {
    const liste = Array.from(dosyaListesi || []);
    const sonuc = [];
    let atlanan = 0;
    const hatalar = [];
    const htmlVar = liste.some((f) => /\.html?$/i.test(f.name));

    for (const f of liste) {
      const yol = f.webkitRelativePath || f.name;
      if (!/\.json$/i.test(f.name)) {
        atlanan++;
        continue;
      }
      // Çok büyük dosyalar (medya listeleri vb.) analiz için gerekmez; 64 MB üstü atlanır.
      if (f.size > 64 * 1024 * 1024) {
        hatalar.push(yol + ': dosya 64 MB sınırını aşıyor, atlandı.');
        continue;
      }
      let metin;
      try {
        metin = await f.text();
      } catch (hata) {
        hatalar.push(yol + ': dosya okunamadı (' + (hata && hata.message ? hata.message : 'bilinmeyen hata') + ').');
        continue;
      }
      let json;
      try {
        json = JSON.parse(metin);
      } catch (hata) {
        hatalar.push(yol + ': geçerli JSON değil (' + (hata && hata.message ? hata.message : 'ayrıştırma hatası') + ').');
        continue;
      }
      const tani = veriSetiTuruBul(yol, json);
      sonuc.push({
        yol,
        ad: f.name,
        boyut: f.size,
        json,
        tur: tani.tur,
        kayitlar: tani.kayitlar,
        kayitSayisi: tani.kayitlar ? tani.kayitlar.length : null,
        not: tani.not,
      });
    }

    if (htmlVar && sonuc.length === 0) {
      hatalar.push(
        'Seçilen dosyalar HTML biçiminde görünüyor. Instagram "Bilgilerini indir" sayfasında biçim olarak JSON seçip arşivi yeniden indirin.'
      );
    }
    return { dosyalar: sonuc, atlanan, hatalar };
  }

  async function iceAktar(dosyaListesi) {
    durum.okunuyor = true;
    ciz();
    try {
      const { dosyalar, atlanan, hatalar } = await dosyalariOku(dosyaListesi);
      // Aynı yol yeniden seçilirse eskisinin yerine geçer; farklı yollar birikir.
      const yollar = new Set(dosyalar.map((d) => yolNormalize(d.yol)));
      durum.dosyalar = durum.dosyalar.filter((d) => !yollar.has(yolNormalize(d.yol))).concat(dosyalar);
      durum.atlananDosyaSayisi += atlanan;
      durum.okumaHatalari = hatalar;

      const kisisel = durum.dosyalar.find((d) => d.tur === 'kisiselBilgi');
      if (kisisel) {
        const oneri = kullaniciAdiOnerisiBul(kisisel.kayitlar);
        if (oneri) {
          durum.kullaniciAdiOnerisi = oneri;
          if (!durum.kullaniciAdim) durum.kullaniciAdim = oneri;
        }
      }
      durum.kullaniciAdiOnaylandi = false;
      durum.analiz = null;
    } finally {
      durum.okunuyor = false;
      ciz();
    }
  }

  function veriyiSifirla() {
    if (kuyrukEtkinMi()) {
      const onay = window.confirm('Etkin bir kuyruk var. Veri sıfırlanırsa kuyruk da iptal edilir. Devam edilsin mi?');
      if (!onay) return;
      durum.kuyruk = null;
    }
    durum.dosyalar = [];
    durum.atlananDosyaSayisi = 0;
    durum.okumaHatalari = [];
    durum.kullaniciAdiOnerisi = null;
    durum.kullaniciAdim = '';
    durum.kullaniciAdiOnaylandi = false;
    durum.analiz = null;
    durum.secilenler = new Set();
    durum.liste.sayfa = 1;
    // [[SIFIRLA: ek alanlar]]
    ciz();
  }

  // ===========================================================================
  // Panel iskeleti
  // ===========================================================================

  const host = el('div', { id: HOST_ID });
  host.style.cssText = 'position:fixed;top:0;right:0;z-index:2147483000;';
  const golge = host.attachShadow({ mode: 'open' });
  golge.appendChild(el('style', { text: STIL }));

  const panel = el('div', { class: 'panel', role: 'dialog', 'aria-label': 'Instagram Manuel Asistan' });
  golge.appendChild(panel);
  document.body.appendChild(host);

  const gorunumler = {
    veri: { etiket: 'Veri', ciz: cizVeri },
    listeler: { etiket: 'Listeler', ciz: cizListeler },
    kuyruk: { etiket: 'Kuyruk', ciz: cizKuyruk },
    kayit: { etiket: 'Kayıt / Dışa aktar', ciz: cizKayit },
    bilgi: { etiket: 'Bilgi', ciz: cizBilgi },
  };

  function kuyrukEtkinMi() {
    return !!(durum.kuyruk && durum.kuyruk.durum !== 'iptal' && durum.kuyruk.durum !== 'bitti');
  }

  function kapat() {
    if (kuyrukEtkinMi()) {
      const onay = window.confirm(
        'Etkin bir manuel kuyruk var. Paneli kapatırsanız kuyruk bu sekmede sona erer ' +
          '(yerel kayıtlar korunur). Yine de kapatılsın mı?'
      );
      if (!onay) return;
    }
    host.remove();
  }

  function ciz() {
    temizle(panel);
    panel.classList.toggle('kucultulmus', durum.kucultulmus);

    // Başlık
    panel.appendChild(
      el('div', { class: 'baslik' }, [
        el('h1', {}, ['Instagram Manuel Asistan', el('span', { class: 'surum', text: 'v' + SURUM })]),
        el('button', {
          class: 'kucuk',
          text: durum.kucultulmus ? 'Büyüt' : 'Küçült',
          onclick: () => {
            durum.kucultulmus = !durum.kucultulmus;
            ciz();
          },
        }),
        el('button', { class: 'kucuk', text: 'Kapat', 'aria-label': 'Paneli kapat', onclick: kapat }),
      ])
    );
    if (durum.kucultulmus) return;

    // Sabit uyarılar
    panel.appendChild(
      el('div', { class: 'uyari' }, [
        el('p', { text: UYARI_OTOMATIK_YOK }),
        el('p', { text: UYARI_VERI_ESKI }),
        el('p', { text: UYARI_KISITLAMA }),
      ])
    );

    // Gezinti
    const gez = el('div', { class: 'gezinti' });
    for (const [ad, g] of Object.entries(gorunumler)) {
      gez.appendChild(
        el('button', {
          text: g.etiket,
          class: durum.goruntu === ad ? 'etkin' : '',
          onclick: () => {
            durum.goruntu = ad;
            ciz();
          },
        })
      );
    }
    panel.appendChild(gez);

    // İçerik
    const icerik = el('div', { class: 'icerik' });
    gorunumler[durum.goruntu].ciz(icerik);
    panel.appendChild(icerik);

    panel.appendChild(
      el('div', { class: 'altbilgi', text: 'Tüm işlemler bu sekmede, yerel olarak yapılır. Ağ isteği gönderilmez.' })
    );
  }

  // ---------------------------------------------------------------------------
  // Görünümler (ileriki bölümlerde doldurulur)
  // ---------------------------------------------------------------------------

  function cizVeri(kap) {
    kap.appendChild(el('h2', { text: 'Veri: Instagram arşivini içe aktar' }));
    kap.appendChild(
      el('p', { class: 'sessiz' }, [
        'Instagram → Ayarlar → Hesaplar Merkezi → Bilgilerini indir → biçim olarak ',
        el('strong', { text: 'JSON' }),
        ' seçin. İndirdiğiniz ZIP dosyasını bilgisayarınızda açın; ardından aşağıdan ' +
          'çıkan klasörü ya da içindeki JSON dosyalarını seçin. Dosyalar yalnızca bu sekmede okunur.',
      ])
    );

    // Dosya seçiciler: yalnızca yerel okuma. Bu girdiler hiçbir yere yükleme yapmaz.
    const cokluGirdi = el('input', { type: 'file', multiple: true, accept: '.json,application/json' });
    cokluGirdi.addEventListener('change', () => iceAktar(cokluGirdi.files));
    const klasorGirdi = el('input', { type: 'file' });
    klasorGirdi.setAttribute('webkitdirectory', '');
    klasorGirdi.setAttribute('directory', '');
    klasorGirdi.addEventListener('change', () => iceAktar(klasorGirdi.files));

    kap.appendChild(
      el('div', { class: 'kart' }, [
        el('div', { class: 'satir' }, [el('label', { text: 'JSON dosyaları seç: ' }), cokluGirdi]),
        el('div', { class: 'satir' }, [el('label', { text: 'Arşiv klasörünü seç: ' }), klasorGirdi]),
        el('p', {
          class: 'sessiz',
          text: 'Klasör seçiminde alt klasörlerdeki tüm dosyalar taranır; JSON olmayanlar atlanır. ' +
            'Büyük arşivlerde okuma birkaç saniye sürebilir.',
        }),
        durum.okunuyor ? el('p', { text: 'Dosyalar okunuyor…' }) : null,
        durum.dosyalar.length > 0 ? el('button', { class: 'kucuk tehlike', text: 'İçe aktarılanları sıfırla', onclick: veriyiSifirla }) : null,
      ])
    );

    if (durum.okumaHatalari.length > 0) {
      kap.appendChild(el('h3', { text: 'Okuma / ayrıştırma hataları' }));
      kap.appendChild(el('ul', { class: 'liste hata' }, durum.okumaHatalari.map((h) => el('li', { text: h }))));
    }

    if (durum.dosyalar.length === 0) {
      kap.appendChild(el('p', { class: 'sessiz', text: 'Henüz dosya seçilmedi.' }));
      return;
    }

    const { sayim, eksikler } = veriSetleriniOzetle(durum.dosyalar);

    // Gerekli / eksik veri setleri
    kap.appendChild(el('h3', { text: 'Gerekli veri setleri' }));
    kap.appendChild(
      el('ul', { class: 'liste' }, GEREKLI_VERI_SETLERI.map((g) => {
        const mevcut = !!sayim[g.tur];
        return el('li', { class: mevcut ? 'basarili' : g.zorunlu ? 'hata' : '' }, [
          (mevcut ? '✔ ' : '✘ ') + VERI_SETI_ETIKETLERI[g.tur] + (mevcut ? ' (' + sayim[g.tur] + ' dosya)' : ' — eksik'),
          el('span', { class: 'sessiz', text: ' · ' + g.aciklama + (g.zorunlu ? ' · zorunlu' : ' · isteğe bağlı') }),
        ]);
      }))
    );
    const zorunluEksik = eksikler.filter((e) => e.zorunlu);
    if (zorunluEksik.length > 0) {
      kap.appendChild(el('p', { class: 'hata', text: 'Zorunlu veri setleri eksik olduğu için analiz yapılamaz. Eksik dosyaları ekleyin.' }));
    }
    if (!sayim.dm) {
      kap.appendChild(el('p', { class: 'sessiz', text: 'Mesaj arşivi yüklenmedi: DM sekmesi "arşiv eksik" durumunu gösterir; bu, hiç yazışılmadığı anlamına gelmez.' }));
    }

    // Kullanıcı adı onayı
    kap.appendChild(el('h3', { text: 'Kullanıcı adınızı onaylayın' }));
    const adGirdi = el('input', { type: 'text', value: durum.kullaniciAdim, placeholder: 'kullanici_adiniz', spellcheck: 'false' });
    adGirdi.addEventListener('input', () => {
      durum.kullaniciAdim = adGirdi.value;
      durum.kullaniciAdiOnaylandi = false;
    });
    kap.appendChild(
      el('div', { class: 'kart' }, [
        el('p', { class: 'sessiz', text: durum.kullaniciAdiOnerisi ? 'Arşivden çıkarılan öneri: ' + durum.kullaniciAdiOnerisi : 'Arşivde kişisel bilgi dosyası bulunamadı; kullanıcı adınızı elle yazın.' }),
        el('div', { class: 'satir' }, [
          el('span', { text: '@' }),
          adGirdi,
          el('button', {
            class: 'birincil',
            text: durum.kullaniciAdiOnaylandi ? 'Onaylandı ✔' : 'Kullanıcı adını onayla',
            disabled: zorunluEksik.length > 0,
            onclick: () => {
              if (!adGirdi.value.trim()) {
                window.alert('Lütfen kullanıcı adınızı girin.');
                return;
              }
              durum.kullaniciAdim = adGirdi.value.trim();
              durum.kullaniciAdiOnaylandi = true;
              analiziCalistir();
              durum.goruntu = 'listeler';
              ciz();
            },
          }),
        ]),
        el('p', { class: 'sessiz', text: 'Kullanıcı adı, DM konuşmalarında karşı tarafı ayırt etmek için kullanılır.' }),
      ])
    );

    // Tespit edilen dosyalar
    kap.appendChild(el('h3', { text: 'Tespit edilen dosyalar (' + durum.dosyalar.length + ')' }));
    if (durum.atlananDosyaSayisi > 0) {
      kap.appendChild(el('p', { class: 'sessiz', text: durum.atlananDosyaSayisi + ' JSON olmayan dosya atlandı.' }));
    }
    const sirali = durum.dosyalar.slice().sort((a, b) => a.yol.localeCompare(b.yol, 'tr'));
    const tablo = el('table', { class: 'tablo' }, [
      el('thead', {}, el('tr', {}, ['Dosya', 'Tür', 'Kayıt', 'Not'].map((b) => el('th', { text: b })))),
      el('tbody', {}, sirali.map((d) =>
        el('tr', { class: d.tur === 'bilinmeyen' ? 'sessiz' : '' }, [
          el('td', {}, el('code', { text: d.yol })),
          el('td', { text: VERI_SETI_ETIKETLERI[d.tur] || d.tur }),
          el('td', { text: d.kayitSayisi === null ? '–' : String(d.kayitSayisi) }),
          el('td', { class: 'sessiz', text: d.not || '' }),
        ])
      )),
    ]);
    kap.appendChild(el('div', { class: 'tablo-kap' }, tablo));
  }

  // ---------------------------------------------------------------------------
  // Profil açma
  // Bu aracın yaptığı TEK dış işlem: kullanıcı düğmeye bastığında profil sayfasını
  // yeni sekmede açmak. Herhangi bir Instagram API uç noktası çağrılmaz, hiçbir
  // takip/takipçi/istek durumu değiştirilmez.
  // ---------------------------------------------------------------------------

  function profilUrl(norm) {
    return 'https://www.instagram.com/' + encodeURIComponent(norm) + '/';
  }

  function profiliAc(norm) {
    window.open(profilUrl(norm), '_blank', 'noopener,noreferrer');
  }

  function tarihBicimle(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '–';
    try {
      return new Date(ms).toLocaleDateString('tr-TR', { year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch (_hata) {
      return new Date(ms).toISOString().slice(0, 10);
    }
  }

  function sonDmMetni(h) {
    const d = h.sonDm;
    if (d.durum === 'var' || d.durum === 'eski') {
      const ek = d.eslesme === 'ad' ? ' (ad eşleşmesi, kesin değil)' : d.eslesme === 'grup-ad' ? ' (grup)' : '';
      return tarihBicimle(d.zamanMs) + ' · ' + DM_DURUM_ETIKETLERI[d.durum] + ek;
    }
    return DM_DURUM_ETIKETLERI[d.durum] || d.durum;
  }

  function isletmeMetni(h) {
    if (h.isletme.durum === 'veriEvet') return 'İşletme (veride belirtilmiş)';
    if (h.isletme.durum === 'manuelEvet') return 'İşletme (elle işaretlendi)';
    return 'Doğrulanamaz';
  }

  const SIRALAMA_ALANLARI = {
    kullaniciAdi: { etiket: 'Kullanıcı adı', deger: (h) => h.norm },
    iliski: { etiket: 'İlişki', deger: (h) => ILISKI_ETIKETLERI[h.iliski] },
    sonDm: { etiket: 'Son DM', deger: (h) => (h.sonDm.zamanMs === null ? -1 : h.sonDm.zamanMs) },
    isletme: { etiket: 'İşletme', deger: (h) => (h.isletme.durum === 'dogrulanamaz' ? 1 : 0) },
    takipTarihi: { etiket: 'Takip tarihi', deger: (h) => h.takipTarihiMs || h.takipciTarihiMs || h.istekTarihiMs || -1 },
  };

  function gorunenHesaplar() {
    const a = durum.analiz;
    if (!a) return [];
    const tanim = LISTE_TANIMLARI.find((t) => t.ad === durum.liste.sekme);
    const normSet = new Set(a.listeler[tanim.ad]);
    const arama = normalizeKullaniciAdi(durum.liste.arama);
    const f = durum.liste.filtreler;
    let sonuc = a.hesaplar.filter((h) => {
      if (!normSet.has(h.norm)) return false;
      if (arama && !h.norm.includes(arama)) return false;
      if (f.dm !== 'hepsi' && h.sonDm.durum !== f.dm) return false;
      if (f.isletme === 'evet' && h.isletme.durum === 'dogrulanamaz') return false;
      if (f.isletme === 'hayir' && h.isletme.durum !== 'dogrulanamaz') return false;
      if (f.kaynak !== 'hepsi' && !h.kaynakDosyalar.includes(f.kaynak)) return false;
      if (f.secili === 'evet' && !durum.secilenler.has(h.norm)) return false;
      return true;
    });
    const alan = SIRALAMA_ALANLARI[durum.liste.siralama.alan] || SIRALAMA_ALANLARI.kullaniciAdi;
    const yon = durum.liste.siralama.yon;
    sonuc.sort((x, y) => {
      const a1 = alan.deger(x);
      const b1 = alan.deger(y);
      if (a1 < b1) return -1 * yon;
      if (a1 > b1) return 1 * yon;
      return x.norm.localeCompare(y.norm);
    });
    return sonuc;
  }

  function cizListeler(kap) {
    kap.appendChild(el('h2', { text: 'Listeler' }));
    const a = durum.analiz;
    if (!a) {
      kap.appendChild(el('p', { class: 'sessiz', text: 'Önce Veri sekmesinden arşiv dosyalarını yükleyin ve kullanıcı adınızı onaylayın.' }));
      return;
    }

    // Özet ve uyarılar
    kap.appendChild(
      el('p', { class: 'sessiz' }, [
        'Toplam ' + a.hesaplar.length + ' tekil hesap · takipçi kaydı ' + a.sayilar.takipciler +
          ' · takip kaydı ' + a.sayilar.takipEdilenler + ' · gönderilen istek ' + a.sayilar.istekGonderilen +
          (a.dm && a.dm.arsivVar ? ' · DM konuşması ' + a.dm.konusmaSayisi + ' (birebir ' + a.dm.birebirSayisi + ', grup ' + a.dm.grupSayisi + ')' : ' · DM arşivi yok'),
      ])
    );
    if (a.uyarilar.length > 0) {
      kap.appendChild(el('ul', { class: 'liste sessiz' }, a.uyarilar.map((u) => el('li', { text: u }))));
    }

    // Sekmeler
    const sekmeler = el('div', { class: 'alt-sekmeler' });
    for (const t of LISTE_TANIMLARI) {
      sekmeler.appendChild(
        el('button', {
          class: 'kucuk' + (durum.liste.sekme === t.ad ? ' etkin' : ''),
          text: t.baslik + ' (' + a.listeler[t.ad].length + ')',
          onclick: () => {
            durum.liste.sekme = t.ad;
            durum.liste.sayfa = 1;
            ciz();
          },
        })
      );
    }
    kap.appendChild(sekmeler);

    const tanim = LISTE_TANIMLARI.find((t) => t.ad === durum.liste.sekme);
    kap.appendChild(el('h3', { text: tanim.baslik }));
    kap.appendChild(el('p', { class: 'sessiz', text: tanim.aciklama }));
    if (tanim.ad === 'dmYok') {
      const grupKutu = el('input', { type: 'checkbox', checked: durum.grupDahil });
      grupKutu.addEventListener('change', () => {
        durum.grupDahil = grupKutu.checked;
        analiziCalistir();
        ciz();
      });
      kap.appendChild(el('label', { class: 'satir' }, [grupKutu, 'Grup konuşmalarını da say (varsayılan: kapalı)']));
    }
    if (tanim.ad === 'isletme') {
      kap.appendChild(
        el('p', { class: 'sessiz', text: 'Bir hesabı herhangi bir sekmede "İşletme olarak işaretle" düğmesiyle buraya ekleyebilir, aynı düğmeyle işareti kaldırabilirsiniz. Elle işaretler yalnızca bu tarayıcıda tutulur.' })
      );
    }
    // [[LİSTE: sekme ek]]

    // Araç çubuğu: arama, sıralama, filtreler
    const aramaGirdi = el('input', { type: 'search', value: durum.liste.arama, placeholder: 'Kullanıcı adında ara' });
    aramaGirdi.addEventListener('input', () => {
      durum.liste.arama = aramaGirdi.value;
      durum.liste.sayfa = 1;
      cizGovde();
    });
    const siralamaSec = el('select', {}, Object.entries(SIRALAMA_ALANLARI).map(([k, v]) => el('option', { value: k, text: v.etiket, selected: durum.liste.siralama.alan === k })));
    siralamaSec.addEventListener('change', () => {
      durum.liste.siralama.alan = siralamaSec.value;
      cizGovde();
    });
    const yonDugme = el('button', { class: 'kucuk', text: durum.liste.siralama.yon === 1 ? 'Artan ↑' : 'Azalan ↓', onclick: () => {
      durum.liste.siralama.yon *= -1;
      ciz();
    } });
    const dmSec = el('select', {}, [
      el('option', { value: 'hepsi', text: 'DM: hepsi' }),
      ...Object.entries(DM_DURUM_ETIKETLERI).map(([k, v]) => el('option', { value: k, text: 'DM: ' + v, selected: durum.liste.filtreler.dm === k })),
    ]);
    dmSec.addEventListener('change', () => { durum.liste.filtreler.dm = dmSec.value; durum.liste.sayfa = 1; cizGovde(); });
    const isletmeSec = el('select', {}, [
      el('option', { value: 'hepsi', text: 'İşletme: hepsi' }),
      el('option', { value: 'evet', text: 'İşletme: işaretli', selected: durum.liste.filtreler.isletme === 'evet' }),
      el('option', { value: 'hayir', text: 'İşletme: doğrulanamaz', selected: durum.liste.filtreler.isletme === 'hayir' }),
    ]);
    isletmeSec.addEventListener('change', () => { durum.liste.filtreler.isletme = isletmeSec.value; durum.liste.sayfa = 1; cizGovde(); });
    const kaynaklar = Array.from(new Set(a.hesaplar.flatMap((h) => h.kaynakDosyalar))).sort();
    const kaynakSec = el('select', {}, [
      el('option', { value: 'hepsi', text: 'Kaynak: hepsi' }),
      ...kaynaklar.map((k) => el('option', { value: k, text: 'Kaynak: ' + dosyaAdi(k), selected: durum.liste.filtreler.kaynak === k })),
    ]);
    kaynakSec.addEventListener('change', () => { durum.liste.filtreler.kaynak = kaynakSec.value; durum.liste.sayfa = 1; cizGovde(); });
    const seciliSec = el('select', {}, [
      el('option', { value: 'hepsi', text: 'Seçim: hepsi' }),
      el('option', { value: 'evet', text: 'Seçim: yalnızca seçililer', selected: durum.liste.filtreler.secili === 'evet' }),
    ]);
    seciliSec.addEventListener('change', () => { durum.liste.filtreler.secili = seciliSec.value; durum.liste.sayfa = 1; cizGovde(); });

    kap.appendChild(el('div', { class: 'satir' }, [aramaGirdi, siralamaSec, yonDugme, dmSec, isletmeSec, kaynakSec, seciliSec]));

    // Seçim denetimleri (kasıtlı olarak "tümünü seç" yoktur; yalnızca görünenler seçilebilir)
    const secimSatiri = el('div', { class: 'satir' });
    kap.appendChild(secimSatiri);

    const govde = el('div');
    kap.appendChild(govde);

    function cizGovde() {
      temizle(secimSatiri);
      temizle(govde);
      const gorunen = gorunenHesaplar();
      const sayfaBoyu = 200;
      const gosterilen = gorunen.slice(0, durum.liste.sayfa * sayfaBoyu);

      secimSatiri.appendChild(el('span', { class: 'sessiz', text: gorunen.length + ' hesap görünüyor · ' + durum.secilenler.size + ' seçili' }));
      secimSatiri.appendChild(el('button', { class: 'kucuk', text: 'Görünenleri seç (' + gosterilen.length + ')', disabled: gosterilen.length === 0, onclick: () => {
        for (const h of gosterilen) durum.secilenler.add(h.norm);
        cizGovde();
      } }));
      secimSatiri.appendChild(el('button', { class: 'kucuk', text: 'Seçimi temizle', disabled: durum.secilenler.size === 0, onclick: () => {
        durum.secilenler.clear();
        cizGovde();
      } }));
      // [[LİSTE: seçim ek]]

      if (gorunen.length === 0) {
        govde.appendChild(el('p', { class: 'sessiz', text: 'Bu ölçütlere uyan hesap yok.' }));
        return;
      }

      const tablo = el('table', { class: 'tablo' }, [
        el('thead', {}, el('tr', {}, ['Seç', 'Kullanıcı adı', 'İlişki', 'Son DM', 'İşletme', 'Kaynak', ''].map((b) => el('th', { text: b })))),
        el('tbody', {}, gosterilen.map((h) => cizHesapSatiri(h, cizGovde))),
      ]);
      govde.appendChild(el('div', { class: 'tablo-kap' }, tablo));
      if (gosterilen.length < gorunen.length) {
        govde.appendChild(el('button', { text: 'Daha fazla göster (' + (gorunen.length - gosterilen.length) + ' kaldı)', onclick: () => {
          durum.liste.sayfa++;
          cizGovde();
        } }));
      }
    }
    cizGovde();
  }

  function cizHesapSatiri(h, yenidenCiz) {
    const kutu = el('input', { type: 'checkbox', checked: durum.secilenler.has(h.norm), 'aria-label': h.kullaniciAdi + ' seç' });
    kutu.addEventListener('change', () => {
      if (kutu.checked) durum.secilenler.add(h.norm);
      else durum.secilenler.delete(h.norm);
      yenidenCiz();
    });
    // Bağlantı: yalnızca profil sayfası. Yeni sekmede, referrer/opener olmadan.
    const baglanti = el('a', { href: profilUrl(h.norm), target: '_blank', rel: 'noopener noreferrer', text: '@' + h.kullaniciAdi });
    return el('tr', {}, [
      el('td', {}, kutu),
      el('td', {}, [baglanti, h.kullaniciAdi.toLowerCase() !== h.norm ? el('span', { class: 'sessiz', text: ' (' + h.norm + ')' }) : null]),
      el('td', { text: ILISKI_ETIKETLERI[h.iliski] }),
      el('td', { class: h.sonDm.durum === 'var' ? '' : 'sessiz', text: sonDmMetni(h) }),
      el('td', {}, cizIsletmeHucresi(h, yenidenCiz)),
      el('td', {}, h.kaynakDosyalar.map((k) => el('code', { text: dosyaAdi(k), title: k }))),
      el('td', {}, el('button', { class: 'kucuk', text: 'Profili aç', onclick: () => profiliAc(h.norm) })),
    ]);
  }

  // Elle işletme etiketi: yalnızca yerel bir işaret. Instagram'a hiçbir şey sorulmaz/yazılmaz.
  function isletmeEtiketiDegistir(h) {
    if (durum.manuelIsletme.has(h.norm)) durum.manuelIsletme.delete(h.norm);
    else durum.manuelIsletme.add(h.norm);
    // Analizi baştan çalıştırmak yerine yalnızca bu hesabın durumunu ve işletme listesini güncelle.
    h.isletme = isletmeDurumu(h, durum.manuelIsletme);
    const tanim = LISTE_TANIMLARI.find((t) => t.ad === 'isletme');
    durum.analiz.listeler.isletme = durum.analiz.hesaplar.filter(tanim.yuklem).map((x) => x.norm);
    // [[İŞLETME: kaydet]]
  }

  function cizIsletmeHucresi(h, yenidenCiz) {
    const veridenGeliyor = h.isletme.durum === 'veriEvet';
    const elleIsaretli = durum.manuelIsletme.has(h.norm);
    const dugme = el('button', {
      class: 'kucuk',
      text: elleIsaretli ? 'İşareti kaldır' : 'İşletme olarak işaretle',
      title: veridenGeliyor ? 'Veride zaten işletme olarak belirtilmiş; elle işaret buna ek tutulur.' : 'Yalnızca yerel bir etiket ekler',
      onclick: () => {
        isletmeEtiketiDegistir(h);
        yenidenCiz();
        // Sekme sayaçları değiştiği için üst düzey yeniden çizim
        ciz();
      },
    });
    return [el('span', { class: h.isletme.durum === 'dogrulanamaz' ? 'sessiz' : '', text: isletmeMetni(h) }), el('br'), dugme];
  }

  function cizKuyruk(kap) {
    kap.appendChild(el('h2', { text: 'Manuel işlem kuyruğu' }));
    kap.appendChild(el('p', { class: 'sessiz', text: 'Kuyruk bölümü henüz eklenmedi.' }));
  }

  function cizKayit(kap) {
    kap.appendChild(el('h2', { text: 'Kayıt ve dışa aktarma' }));
    kap.appendChild(el('p', { class: 'sessiz', text: 'Kayıt bölümü henüz eklenmedi.' }));
  }

  function cizBilgi(kap) {
    kap.appendChild(el('h2', { text: 'Bilgi ve gizlilik' }));
    kap.appendChild(
      el('ul', { class: 'liste' }, [
        el('li', { text: 'Araç yalnızca www.instagram.com üzerinde ve yalnızca bu sekmede çalışır.' }),
        el('li', { text: 'Seçtiğiniz dosyalar tarayıcı belleğinde okunur; hiçbir sunucuya gönderilmez.' }),
        el('li', { text: 'Hiçbir Instagram uç noktasına istek yapılmaz; hiçbir Instagram düğmesine tıklanmaz.' }),
        el('li', { text: 'Parola, çerez, oturum kimliği, CSRF belirteci veya yetki başlığı okunmaz.' }),
        el('li', { text: 'Tek dış işlem: düğmeye bastığınızda profil sayfasını yeni sekmede açmak.' }),
        el('li', { text: UYARI_DOGRULAMA_YOK }),
        el('li', { text: UYARI_KISITLAMA }),
      ])
    );
  }

  // [[BÖLÜM: arayüz ek]]

  // Denetim ve test için salt okunur API (sayfa değişkenlerine yazmaz, yalnızca bu adı tanımlar).
  window.igManuelAsistan = API;

  ciz();
  console.info('[ig-manuel-asistan] v' + SURUM + ' yüklendi. ' + UYARI_OTOMATIK_YOK);
})();
