# Lofi Video Pipeline

Lofi müzik videoları üretimi için otomatik prep (hazırlık) ve ffmpeg tabanlı montaj boru hattı (pipeline).

Bu proje iki ana katmandan oluşur:
1. **Montaj Otomasyonu (Katman 1 - `build.js`):** Suno müzik parçalarını, Hailuo video klip döngüsünü ve ambient ses efektlerini otomatik olarak birleştirir, YouTube uyumlu tracklist ve rapor üretir.
2. **Hazırlık Otomasyonu (Aşama 7 / `prep`):** Proje iskeleti oluşturma, prompt şablonları doldurma, `prompts.md` üretimi ve Gemini API ile stil kartı (`add-style.js`) analiz otomasyonu.
3. **Panel (Aşama 8 / `npm start`):** Üç komutu numaralı bir menüden çalıştırır; istenirse proje klasörüne bakıp kaldığı yerden devam eder.

---

## 🛠️ Kurulum

Gereksinimler:
- Node.js (>=22)
- ffmpeg (9.0.1+ PATH üzerinde)

Depoyu klonlayıp dizine geçin. Ek bir `npm install` bağımlılığı yoktur (Node.js dahili modülleri kullanılır).

### `.env` Kurulumu (Opsiyonel - Stil Analizi İçin)

Stil kartı oluşturma (`node add-style.js`) özelliğini kullanmak için projenin kök dizininde `.env` dosyası oluşturun:

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

```
lofi — üretim paneli
Proje: video3-Neo Tokyo Night — sıradaki: Faz 3 — Klip (image-to-video)
  1) Projeye devam et (kaldığı yerden)
  2) Yeni proje oluştur
  3) Stil ekle (görselden, Gemini)
  4) Klibi seç (project.json → clip)
  5) Montaj (build)
  6) Proje durumu
  7) Stiller ve ambient'ler
  8) Başka proje seç
  0) Çık
```

- **Tek tek:** 2–8 ilgili işi yapar. Komutlar (`new-video.js`, `add-style.js`, `build.js`) aşağıdaki bayraklarla, ayrı süreçte çalışır; çıktıları doğrudan terminale akar.
- **Sıralı mod (1):** Panel proje klasörüne bakıp sıradaki adımı bulur. Durum hiçbir yere kaydedilmez, her seferinde dosyalardan okunur; ertesi gün aynı projeyi seçince oradan sürer.

| Klasörde görülen | Sıradaki adım |
|---|---|
| `out\final_ambient.mp4` var | Bitti |
| `clip` dolu ve dosyası var, `audio\` klasöründe parça var | Montaj (onayla → `build.js`) |
| `clip` dolu ve dosyası var, `audio\` boş | Elle: Suno parçalarını `audio\` altına koy |
| `videolar\` altında `.mp4` var, `clip` boş (ya da dosyası yok) | Klibi seç → panel `clip` alanını yazar |
| `resimler\MASTER.*` var | Elle: Faz 3 (`prompts.md`) |
| Hiçbiri | Elle: Faz 1 (`prompts.md`) |

  Elle yapılan adımlarda `1) Tekrar kontrol et` seçeneği var. Yalnızca Faz 1 ve Faz 3'te `2) Bu oturumda atla` da çıkar; atlama panel kapanınca unutulur.
- **Klip seçimi:** project.json'da yalnızca `clip` değişir (`./videolar/in.mp4` biçiminde). Dosya 2 boşluk girintiyle yeniden yazılır.
- **Ctrl+C:** Menüdeyken paneli kapatır. Bir komut çalışırken yalnızca o komutu durdurur, panel açık kalır.
- Panel etkileşimli terminal ister; çıktı dosyaya ya da boruya yönlendirilirse çıkış kodu 2 ile kapanır.

### 1. Yeni Stil Kartı Analizi (`add-style.js`)
Referans bir görselden Gemini Flash ile stil analizi yapıp `styles/<name>.json` ve `styles/refs/<name>.<ext>` üretir:

```bash
node add-style.js "C:\yol\referans.jpg" --name "cozy-realistic"
```

Var olan stili güncellemek için:
```bash
node add-style.js "C:\yol\referans.jpg" --name "cozy-realistic" --overwrite
```

### 2. Yeni Video Projesi İskeleti Oluşturma (`new-video.js`)
Seçilen stil ve opsiyonel ambient ses efekti ile proje iskeletini (`STYLE_BLOCK.txt`, `project.json`, `prompts.md`) açar:

```bash
node new-video.js "video3-Neo Tokyo Night" --style cozy-realistic --ambient heavyRain
```

### 3. Video Montajını Başlatma (`build.js`)
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

Tüm testler (228 test) network bağımlılığı olmadan mock `fetch` / `sleep` kullanarak çalışır. Panel testleri sahte giriş akışı ve komutları kaydeden sahte çalıştırıcıyla yürür.

---

## 📁 Proje Yapısı

```
lofi/
├── add-style.js           # Gemini API ile görsel stil analizi CLI
├── build.js               # Montaj ve ffmpeg build CLI
├── lofi.js                # Panel (npm start)
├── new-video.js           # Proje iskeleti oluşturma CLI
├── core/                  # Çekirdek yardımcılar (ffmpeg, workspace, config, vb.)
├── prep/                  # Hazırlık modülleri (gemini, scaffold, prompts, styles, ambients, project-status, project-file)
├── ui/                    # Panel: prompt (soru/seçim), runner (komutu ayrı süreçte çalıştırma), actions (menü akışları)
├── prompts/               # Faz 1-3 prompt şablonları (faz1-master, faz2-angles, faz3-motion)
├── steps/                 # Build adımları (concat, video-loop, mix, vb.)
├── styles/                # Tanımlı stiller ve referans görselleri (styles/refs/)
└── test/                  # Unit ve branch testleri
```

---

## ⚙️ Manuel ve Otomatik İş Bölümü

- **Otomatik (Pipeline):** Proje iskelet kurulumu, prompt markdown üretimi, Gemini ile stil kartı analizi, ffmpeg montajı, crossfade loop, ambient miksajı, tracklist ve rapor üretimi. Panel ayrıca sıradaki adımı bulur ve `clip` alanını yazar.
- **Manuel (Kullanıcı Yargısı):** Suno'da müzik üretimi, Google AI Studio / Gemini Image ile master frame üretimi, Hailuo ile video klip üretimi. Donanım VRAM kısıtları nedeniyle medya üretimi bulut/manuel araçlarda kalmaktadır.
