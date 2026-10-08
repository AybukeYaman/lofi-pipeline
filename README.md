# Lofi Video Pipeline

Lofi müzik videoları üretimi için otomatik prep (hazırlık) ve ffmpeg tabanlı montaj boru hattı (pipeline).

Bu proje iki ana katmandan oluşur:
1. **Montaj Otomasyonu (Katman 1 - `build.js`):** Suno müzik parçalarını, Hailuo video klip döngüsünü ve ambient ses efektlerini otomatik olarak birleştirir, YouTube uyumlu tracklist ve rapor üretir.
2. **Hazırlık Otomasyonu (`prep`):** Proje iskeleti oluşturma ve Gemini API ile albüm müzik planı. Görseller elle üretilir.
3. **Arayüz (`npm start`):** Masaüstü uygulaması (Electron + React). Proje listesi, 6 adımlı montaj sihirbazı, Shorts alt projeleri, Ambiance/Mimi/Prompt kütüphaneleri. _(Terminal paneli 8 Ekim 2026'da kaldırıldı; bu dokümanın eski bölümlerinde geçen "panel" atıfları artık geçerli değil.)_

---

## 🛠️ Kurulum

Gereksinimler:
- Node.js (>=22)
- ffmpeg (9.0.1+ PATH üzerinde)

Depoyu klonlayıp dizinde `npm install` çalıştırın. Bağımlılıklar arayüz tarafında (React/Vite/Electron) ve Suno botunda (Playwright); montaj zincirinin kendisi yalnızca Node.js dahili modülleriyle ve ffmpeg ile yazılmıştır.

### `.env` Kurulumu (Opsiyonel - Müzik Planı İçin)

Albüm müzik planını Gemini ile üretmek için projenin kök dizininde `.env` dosyası oluşturun (yoksa yerel plan kullanılır):

```env
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-3.6-flash
```

> **Güvenlik Notu:** `.env` dosyası `.gitignore` altındadır. API key asla URL parametresi olarak gönderilmez veya loglara yazdırılmaz.

---

## 🚀 CLI Kullanımı

### 0. Panel (`npm start`)
Repo klasöründe, PowerShell'de:

```bash
npm start
```

Menü (Windows'taki görünüm; işaretçi `>`):

```
lofi — üretim paneli
? Proje: video3-Neo Tokyo Night — sıradaki: Faz 3 — Klip (image-to-video)
> Projeye devam et (kaldığı yerden)
  Yeni proje oluştur
  Stil ekle (görselden, Gemini)
  Klibi seç (project.json → clip)
  Montaj (build)
  Toplu montaj (birden fazla proje)
  Proje durumu
  Stiller ve ambient'ler
  Başka proje seç
  Çık
```

| Tuş | Anlamı |
|---|---|
| ↑ / ↓ | Seçenekler arasında gezin (uzun listeler 10 satırda kayar) |
| Enter | Seç / onayla |
| Boşluk | Çoklu seçimde (toplu montaj) işaretle `[x]` / kaldır `[ ]` |
| Esc | Geri (soruyu iptal et, bir önceki ekrana dön) |
| Ctrl+C | Menüdeyken paneli kapatır; bir komut çalışırken yalnızca o komutu durdurur |

Onay soruları "Evet / Hayır" seçimidir (yazarak değil).

- **Tek tek:** Menü öğeleri ilgili işi yapar. Komutlar (`new-video.js`, `build.js`) aşağıdaki bayraklarla, ayrı süreçte çalışır; çıktıları doğrudan terminale akar.
- **Toplu montaj:** Montaja hazır projeler (klip seçili, `audio\` dolu, çıktı yok) listelenir. Boşluk ile işaretlenenler sırayla `build.js` ile derlenir. Çıktısı olan projeler listede görünür ama seçilemez. Bir projenin hatası diğerlerini durdurmaz; Ctrl+C ile bir montaj durdurulursa kalanların iptal edilip edilmeyeceği sorulur. Sonda özet basılır.
- **Sıralı mod (Projeye devam et):** Panel proje klasörüne bakıp sıradaki adımı bulur. Durum hiçbir yere kaydedilmez, her seferinde dosyalardan okunur; ertesi gün aynı projeyi seçince oradan sürer.

| Klasörde görülen | Sıradaki adım |
|---|---|
| `out\final_ambient.mp4` var | Bitti |
| `clip` dolu ve dosyası var, `audio\` klasöründe parça var | Montaj (onayla → `build.js`) |
| `clip` dolu ve dosyası var, `audio\` boş | Elle: Suno parçalarını `audio\` altına koy |
| `videolar\` altında `.mp4` var, `clip` boş (ya da dosyası yok) | Klibi seç → panel `clip` alanını yazar |
| Hiçbiri | Elle: döngü klibini `videolar\` altına koy |

  Elle yapılan adımlarda "Tekrar kontrol et" seçeneği var. Yalnızca klip adımında (`faz3`) "Bu oturumda atla" da çıkar; atlama panel kapanınca unutulur.
- **Klip seçimi:** project.json'da yalnızca `clip` değişir (`./videolar/in.mp4` biçiminde). Dosya 2 boşluk girintiyle yeniden yazılır.
- Panel etkileşimli terminal ister; çıktı dosyaya ya da boruya yönlendirilirse (ör. Git Bash) çıkış kodu 2 ile kapanır.
- **Terminal kontrolü:** Ok tuşlarının bir terminalde güvenilir çalıştığını doğrulamak için `npm run tty-check`. Betik; seçim, kaydırma, çoklu seçim, Türkçe giriş, Esc, alt süreç devri ve Ctrl+C adımlarını tek tek sınar ve sonuç satırı basar.

### 1. Yeni Video Projesi İskeleti Oluşturma (`new-video.js`)
İsteğe bağlı ambient ses efekti ile proje iskeletini (`project.json`) açar:

```bash
node new-video.js "video3-Neo Tokyo Night" --ambient heavyRain
```

### 2. Video Montajını Başlatma (`build.js`)
Hazırlanan projenin montajını ve işlenmesini başlatır:

```bash
node build.js --project "C:\yol\videolar\video3-Neo Tokyo Night\project.json"
```

---

## 🧪 Testler

Unit ve dal testlerini çalıştırmak için:

```bash
npm test
```

Tüm testler (248 test) network bağımlılığı olmadan mock `fetch` / `sleep` kullanarak çalışır. Panel akış testleri değer yanıtlı sahte prompter (`test/helpers/fake-prompter.js`) ve komutları kaydeden sahte çalıştırıcıyla; enquirer adaptörü gerçek enquirer ile `show: false` modunda tuş basılarak sınanır. Gerçek terminalde ok tuşları ve raw mode otomatik sınanamaz — onun için `npm run tty-check`.

---

## 📁 Proje Yapısı

```
lofi/
├── build.js               # Montaj ve ffmpeg build CLI
├── lofi.js                # Panel (npm start)
├── new-video.js           # Proje iskeleti oluşturma CLI
├── core/                  # Çekirdek yardımcılar (ffmpeg, workspace, config, vb.)
├── prep/                  # Hazırlık modülleri (gemini, scaffold, ambients, project-status, project-file)
├── ui/                    # Panel: prompt (enquirer adaptörü), runner (komutu ayrı süreçte çalıştırma), actions (menü akışları)
├── scripts/               # tty-check (terminal doğrulaması, elle çalıştırılır)
├── prompts/library/       # Kullanıcının kendi prompt kütüphanesi
├── steps/                 # Build adımları (concat, video-loop, mix, vb.)
└── test/                  # Unit ve branch testleri
```

---

## ⚙️ Manuel ve Otomatik İş Bölümü

- **Otomatik (Pipeline):** Proje iskelet kurulumu, Gemini ile müzik planı, 24/7 yayın paketi (`background.mp4` + `music/`), ffmpeg montajı, crossfade loop, ambient miksajı, tracklist ve rapor üretimi. Panel ayrıca sıradaki adımı bulur, `clip` alanını yazar ve birden fazla projeyi sırayla derler.
- **Manuel (Kullanıcı Yargısı):** Suno'da müzik üretimi, Hailuo ile video klip üretimi. Donanım VRAM kısıtları nedeniyle medya üretimi bulut/manuel araçlarda kalmaktadır.
