// Sentetik Instagram arşivi üretir. Tüm kullanıcı adları uydurmadır; gerçek veri içermez.
// Çalıştırma: node test/fixtures/olustur.js
'use strict';
const fs = require('fs');
const path = require('path');

const KOK = path.join(__dirname, 'arsiv');
const SIMDI = Date.parse('2026-09-04T00:00:00Z'); // testlerde sabit "şimdi"
const GUN = 24 * 60 * 60 * 1000;

// Instagram dÄ±Åa aktarÄ±mÄ± UTF-8 baytlarÄ±nÄ± Latin-1 gibi kaÃ§Ä±rÄ±r; sentetik veride bunu taklit eder.
const bozuk = (s) => Buffer.from(s, 'utf8').toString('latin1');

function kayit(kullaniciAdi, gunOnce) {
  return {
    title: '',
    media_list_data: [],
    string_list_data: [
      { href: 'https://www.instagram.com/' + kullaniciAdi, value: kullaniciAdi, timestamp: Math.floor((SIMDI - gunOnce * GUN) / 1000) },
    ],
  };
}

function mesaj(gonderen, gunOnce, icerik) {
  return { sender_name: gonderen, timestamp_ms: SIMDI - gunOnce * GUN, content: icerik, is_geoblocked_for_viewer: false };
}

function yaz(gorelYol, veri) {
  const tam = path.join(KOK, gorelYol);
  fs.mkdirSync(path.dirname(tam), { recursive: true });
  fs.writeFileSync(tam, JSON.stringify(veri, null, 2) + '\n');
}

fs.rmSync(KOK, { recursive: true, force: true });

// Takipçiler: iki dosyaya bölünmüş kök dizi (yeni biçim). "Ali.Veli" büyük harfle: normalizasyon testi.
yaz('connections/followers_and_following/followers_1.json', [
  kayit('Ali.Veli', 400),
  kayit('ayse_yilmaz', 300),
  kayit('deneme_hesap', 20),
  kayit('sadece_takipci', 10),
]);
yaz('connections/followers_and_following/followers_2.json', [
  kayit('ali.veli', 400), // aynı hesabın farklı yazımı → tekilleşmeli
  kayit('gecmis_arkadas', 900),
]);

// Takip ettiklerim
yaz('connections/followers_and_following/following.json', {
  relationships_following: [
    kayit('ali.veli', 401),
    kayit('ayse_yilmaz', 299),
    kayit('deneme_hesap', 19),
    kayit('mehmet.kaya', 700),
    kayit('gecmis_arkadas', 899),
    kayit('sessiz_hesap', 500),
    kayit('magaza_ornek', 100),
    kayit('test_kullanicisi', 1), // kendisi → atlanmalı
  ],
});

// Gönderilen bekleyen istekler
yaz('connections/followers_and_following/pending_follow_requests.json', {
  relationships_follow_requests_sent: [kayit('bekleyen_istek', 5), kayit('sadece_takipci', 3)],
});

// Gelen istekler: listeye ALINMAMALI
yaz("connections/followers_and_following/follow_requests_you've_received.json", {
  relationships_follow_requests_received: [kayit('gelen_istek_gonderen', 2)],
});

// Diğer ilişki dosyası: tanınır, kullanılmaz
yaz('connections/followers_and_following/close_friends.json', {
  relationships_close_friends: [kayit('ayse_yilmaz', 50)],
});

// Kişisel bilgi (mojibake içeren ad)
yaz('personal_information/personal_information/personal_information.json', {
  profile_user: [
    {
      title: '',
      media_map_data: {},
      string_map_data: {
        Username: { href: '', value: 'test_kullanicisi', timestamp: 0 },
        Name: { href: '', value: 'Test KullanÄ±cÄ±sÄ±', timestamp: 0 },
      },
    },
  ],
});

// DM: ayşe ile son 1 yıl içinde (iki parçalı konuşma)
yaz('your_instagram_activity/messages/inbox/ayse_yilmaz_17842000000000001/message_1.json', {
  participants: [{ name: 'AyÅŸe YÄ±lmaz' }, { name: 'Test KullanÄ±cÄ±sÄ±' }],
  messages: [mesaj('AyÅŸe YÄ±lmaz', 30, 'Selam'), mesaj('Test KullanÄ±cÄ±sÄ±', 31, 'Merhaba')],
  title: 'AyÅŸe YÄ±lmaz',
  is_still_participant: true,
  thread_path: 'inbox/ayse_yilmaz_17842000000000001',
});
yaz('your_instagram_activity/messages/inbox/ayse_yilmaz_17842000000000001/message_2.json', {
  participants: [{ name: 'AyÅŸe YÄ±lmaz' }, { name: 'Test KullanÄ±cÄ±sÄ±' }],
  messages: [mesaj('AyÅŸe YÄ±lmaz', 800, 'Eski mesaj')],
  title: 'AyÅŸe YÄ±lmaz',
  is_still_participant: true,
  thread_path: 'inbox/ayse_yilmaz_17842000000000001',
});

// DM: mehmet ile 365 günden eski
yaz('your_instagram_activity/messages/inbox/mehmet.kaya_17842000000000002/message_1.json', {
  participants: [{ name: 'Mehmet Kaya' }, { name: 'Test KullanÄ±cÄ±sÄ±' }],
  messages: [mesaj('Mehmet Kaya', 500, 'Nasılsın')],
  title: 'Mehmet Kaya',
  is_still_participant: true,
  thread_path: 'inbox/mehmet.kaya_17842000000000002',
});

// Grup konuşması: sessiz_hesap yalnızca grupta yazmış (varsayılan: sayılmaz)
yaz('your_instagram_activity/messages/inbox/tatilgrubu_17842000000000003/message_1.json', {
  participants: [{ name: 'sessiz_hesap' }, { name: 'Mehmet Kaya' }, { name: 'Test KullanÄ±cÄ±sÄ±' }],
  messages: [mesaj('sessiz_hesap', 2, 'Grup mesajı')],
  title: 'Tatil grubu',
  is_still_participant: true,
  thread_path: 'inbox/tatilgrubu_17842000000000003',
});

// Eşleşmeyen birebir konuşma (silinmiş hesap)
yaz('your_instagram_activity/messages/inbox/instagramuser_17842000000000004/message_1.json', {
  participants: [{ name: 'Instagram User' }, { name: 'Test KullanÄ±cÄ±sÄ±' }],
  messages: [mesaj('Instagram User', 40, 'Merhaba')],
  title: 'Instagram User',
  is_still_participant: false,
  thread_path: 'inbox/instagramuser_17842000000000004',
});

// Mesaj isteği klasörü: gelen kutusu değil, kullanılmamalı
yaz('your_instagram_activity/messages/message_requests/yabanci_17842000000000005/message_1.json', {
  participants: [{ name: 'Yabanci' }, { name: 'Test KullanÄ±cÄ±sÄ±' }],
  messages: [mesaj('Yabanci', 1, 'Reklam')],
  title: 'Yabanci',
  is_still_participant: true,
  thread_path: 'message_requests/yabanci_17842000000000005',
});

// Alakasız dosya: tanınmamalı
yaz('ads_information/ads_and_topics/ads_viewed.json', { impressions_history_ads_seen: [{ title: 'reklam' }] });

console.log('Sentetik arşiv yazıldı:', KOK);
