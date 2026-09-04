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

  // [[BÖLÜM: yardımcılar]]

  // [[BÖLÜM: veri seti algılama]]

  // [[BÖLÜM: analiz]]

  // ===========================================================================
  // Dışa verilen saf API (test ve denetim için; hiçbir fonksiyon durum değiştirmez)
  // ===========================================================================

  const API = Object.freeze({
    SURUM,
    STORAGE_KEY,
    DM_ESIK_GUN,
    BEKLEME_MIN_SN,
    BEKLEME_MAX_SN,
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
    /* [[STİL: ek]] */
  `;

  // ===========================================================================
  // Uygulama durumu (yalnızca bu sekmede, bellekte)
  // ===========================================================================

  const durum = {
    goruntu: 'veri', // veri | listeler | kuyruk | kayit | bilgi
    kucultulmus: false,
    kuyruk: null, // etkin kuyruk varsa nesne (ileriki bölümlerde doldurulur)
    // [[DURUM: alanlar]]
  };

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
    kap.appendChild(el('h2', { text: 'Veri' }));
    kap.appendChild(el('p', { class: 'sessiz', text: 'İçe aktarma bölümü henüz eklenmedi.' }));
  }

  function cizListeler(kap) {
    kap.appendChild(el('h2', { text: 'Listeler' }));
    kap.appendChild(el('p', { class: 'sessiz', text: 'Önce Veri sekmesinden arşiv dosyalarını yükleyin.' }));
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
