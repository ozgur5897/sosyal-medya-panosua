# Sosyal Medya İş Panosu

Üyelikli, rol tabanlı bir iş takip panosu. İçerik isteklerini açtığınız, sosyal medya ekibinin onaylayıp paylaştığı bir sistem.

## Ne yapar?

- **Üyelik:** Kullanıcı adı + şifre ile giriş. İlk çalıştırmada oluşturduğun hesap otomatik yönetici olur.
- **Roller:** "İstek Sahibi" iş açabilir ve yorum yapabilir. "Sosyal Medya Ekibi" onaylama, tamamlama, paylaşma, düzenleme, silme ve medya yükleme yapabilir. Bu kısıtlama sunucu tarafında uygulanıyor — sahte değil, gerçek yetkilendirme.
- **Yönetici paneli:** Yeni kullanıcı ekleme, rol değiştirme, hesap devre dışı bırakma/yeniden etkinleştirme (kullanıcılar asla tamamen silinmiyor — geçmiş kayıtlar bozulmasın diye devre dışı bırakılıyor).
- **4 aşamalı süreç:** Onay bekliyor → Devam ediyor → Tamamlandı → Paylaşım yapıldı. "Tamamlandı" aşaması, içerik hazır ama henüz paylaşılmadıysa paylaşım tarihi geçince hâlâ "Gecikti" gösterir.
- **Platform ve marka etiketleri:** Instagram/X/YouTube/TikTok/LinkedIn/Facebook + Bex Coffee/Estanbul Gaming/Ortak.
- **Bağlantı alanı:** İşe opsiyonel bir referans linki eklenebilir (örnek görsel/video ile birlikte veya onun yerine).
- **Düzenleme ve silme:** Sosyal medya ekibi bir işi düzenleyebilir veya silebilir; her ikisi de "Geçmiş" ekranında loglanıyor. Silinen bir işin tam içeriği (açıklama, yorumlar, platform/marka) geçmişte "içeriği göster" ile açılabiliyor.
- **Yorumlar ve medya:** Herkes yorum yapabilir; son görsel/video yüklemesi sosyal medya ekibine ait.

## Kurulum

1. Python 3.10+ kurulu olmalı.
2. Bu klasörde bir terminal açın:

```bash
pip install -r requirements.txt
```

## Çalıştırma

```bash
uvicorn main:app --host 0.0.0.0 --port 8000
```

Tarayıcıdan `http://localhost:8000` adresine girin. İlk açılışta karşınıza "İlk kurulum" ekranı çıkar — burada oluşturduğunuz hesap otomatik olarak yönetici olur. Sonrasında yönetici, "Kullanıcılar" ekranından ekip arkadaşlarınızı ekleyebilir.

Aynı ağdaki diğer cihazlar `http://<bu-bilgisayarın-ip-adresi>:8000` ile erişebilir. Herkesin her yerden erişmesi gerekiyorsa bir sunucuya (VPS, Render, Railway vb.) kurulması gerekir — isterseniz bu adımda da yardımcı olurum.

## Veriler nerede saklanıyor?

- Kullanıcılar, işler, yorumlar ve değişiklik geçmişi `data.db` dosyasında (SQLite).
- Yüklenen görsel/videolar `uploads/` klasöründe.
- Oturum imzalama anahtarı `secret_key.txt` içinde — bu dosyayı silmeyin, silerseniz herkesin oturumu kapanır (yeniden giriş yapmaları yeterli, veri kaybı olmaz).

Bu üç öğeyi yedeklemeniz yeterli.

## Güvenlik notu

Şifreler düz metin değil, tuzlanmış (salted) ve 200.000 tur PBKDF2-SHA256 ile hash'lenmiş olarak saklanıyor. Oturumlar imzalı çerezlerle yönetiliyor. Yine de bu, halka açık internete doğrudan açmak için değil, ekip içi/özel ağda veya HTTPS arkasında bir sunucuda çalıştırmak için tasarlandı — halka açık bir sunucuya koyacaksanız önüne bir ters proxy (nginx/Caddy) ve HTTPS eklemenizi öneririm, isterseniz o kurulumda da yardımcı olurum.
