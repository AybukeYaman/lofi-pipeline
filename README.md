# Lofi Video Pipeline

Lofi müzik videoları üretimi için otomatik prep (hazırlık) ve ffmpeg tabanlı montaj boru hattı (pipeline).

Bu proje iki ana katmandan oluşur:
1. **Montaj Otomasyonu (Katman 1 - `build.js`):** Suno müzik parçalarını, Hailuo video klip döngüsünü ve ambient ses efektlerini otomatik olarak birleştirir, YouTube uyumlu tracklist ve rapor üretir.
2. **Hazırlık Otomasyonu (Aşama 7 / `prep`):** Proje iskeleti oluşturma, prompt şablonları doldurma, `prompts.md` üretimi ve Gemini API ile stil kartı (`add-style.js`) analiz otomasyonu.

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

Tüm testler (164 test) network bağımlılığı olmadan mock `fetch` / `sleep` kullanarak çalışır.

---

## 📁 Proje Yapısı

```
lofi/
├── add-style.js           # Gemini API ile görsel stil analizi CLI
├── build.js               # Montaj ve ffmpeg build CLI
├── new-video.js           # Proje iskeleti oluşturma CLI
├── core/                  # Çekirdek yardımcılar (ffmpeg, workspace, config, vb.)
├── prep/                  # Hazırlık modülleri (gemini, scaffold, prompts, styles, ambients)
├── prompts/               # Faz 1-3 prompt şablonları (faz1-master, faz2-angles, faz3-motion)
├── steps/                 # Build adımları (concat, video-loop, mix, vb.)
├── styles/                # Tanımlı stiller ve referans görselleri (styles/refs/)
└── test/                  # Unit ve branch testleri
```

---

## ⚙️ Manuel ve Otomatik İş Bölümü

- **Otomatik (Pipeline):** Proje iskelet kurulumu, prompt markdown üretimi, Gemini ile stil kartı analizi, ffmpeg montajı, crossfade loop, ambient miksajı, tracklist ve rapor üretimi.
- **Manuel (Kullanıcı Yargısı):** Suno'da müzik üretimi, Google AI Studio / Gemini Image ile master frame üretimi, Hailuo ile video klip üretimi. Donanım VRAM kısıtları nedeniyle medya üretimi bulut/manuel araçlarda kalmaktadır.
