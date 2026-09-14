# Lofi Video Pipeline — Devir ve Mimari Dokümanı (Aşama 7 Kapanışı)

> **Durum (2026-09-14):** Pipeline Katman 1 (Montaj Otomasyonu: Aşama 1–6) ve Katman 2 (Hazırlık Otomasyonu: Aşama 7a, 7b, 7c, 7d-1, 7d-2) başarıyla tamamlandı. `npm test` 164/164 test geçiyor. Gerçek Gemini API kabul testi doğrulandı.

---

## 1. Projenin Amacı ve Boru Hattı (Pipeline)

Bu proje, Lofi müzik videoları üretirken karşılaşılan iki ana darboğazı çözer:
1. **Montaj Otomasyonu (`build.js`):** Müzik parçaları (Suno), video döngü klibi (Hailuo) ve ambient ses efektlerini ffmpeg filtre zinciri ile birleştirerek 48+ dakikalık yayına hazır MP4 video, `tracklist.txt` ve rapor üretir.
2. **Hazırlık Otomasyonu (`prep/` & `add-style.js` & `new-video.js`):** Yeni video projesi için iskelet dizin yapısını açar, Gemini API ile referans görselden stil kartı analiz eder, prompt şablonlarını doldurarak `prompts.md` üretir.

---

## 2. Aşama 7 Kapsamında Tamamlanan Modüller

- **`prep/scaffold.js` & `new-video.js` (7a):** Proje iskeleti (`audio/`, `resimler/`, `videolar/`), `project.json`, `STYLE_BLOCK.txt` ve `prompts.md` üretimi.
- **`prep/styles.js` & `prep/ambients.js` (7b):** `styles/<ad>.json` okuma, saf doğrulama (`validateStyle`), `STYLE_FIELDS` tanımı, referans görsel arama (`findStyleRef`), ambient ses kütüphanesi tarama.
- **`prep/prompts.js` (7c):** Prompt şablonları taranması, `STYLE_BLOCK` ve `MOTION_HINTS` ile şablon doldurma, BOM/CRLF temizliği ve `prompts.md` oluşturulması.
- **`prep/gemini.js` (7d-1):** Gemini API HTTP client katmanı (`generateContent`, `listModels`), `x-goog-api-key` header yönetimi, exponential backoff + Retry-After retry mekanizması, günlük kota (PerDay) ve istemci hatalarında retry yapılmaması.
- **`prep/describe-style.js` & `add-style.js` (7d-2):** Görsel stil analizi için prompt ve Structured Outputs JSON Schema üretimi, `add-style.js` CLI komutu, model doğrulama, dosya kopyalama, JSON yazım rollback mantığı.

---

## 3. Kullanım Örnekleri

### Stil Analizi ve Ekleme (`add-style.js`)
Referans bir görselden Gemini Flash/Omni modelleriyle stil analizi yapıp stil kartı oluşturma:
```bash
node add-style.js "C:\görseller\referans.jpg" --name "cozy-realistic"
```
Var olan stili ezerek güncellemek için:
```bash
node add-style.js "C:\görseller\referans.jpg" --name "cozy-realistic" --overwrite
```

### Yeni Video Projesi İskeleti Oluşturma (`new-video.js`)
Stil ve opsiyonel ambient seçerek proje klasörü hazırlama:
```bash
node new-video.js "video3-Neo Tokyo Night" --style cozy-realistic --ambient heavyRain
```

### Montaj ve Build (`build.js`)
```bash
node build.js --project "C:\videolar\video3-Neo Tokyo Night\project.json"
```

---

## 4. Stil Ekleme Akışı

```text
[Referans Görsel (.jpg/.png/.webp)] 
        │
        ▼ (Dosya boyutu < 15MB & Uzantı kontrolü)
[add-style.js] ──(listModels doğrulaması)──► [Gemini API (x-goog-api-key)]
        │                                             │ (Structured Output JSON)
        ▼                                             ▼
[styles/refs/<name>.<ext>] ◄──(Rollback Güvencesi)── [styles/<name>.json]
        │
        ▼ (new-video.js ile projeye aktarım)
[videolar/<proje>/resimler/style-ref.<ext>] + [prompts.md]
```

---

## 5. Gemini API Key ve Environment Yapılandırması

Repo kökündeki `.env` dosyasında yapılandırılır:
```env
GEMINI_API_KEY=your_actual_api_key_here
GEMINI_MODEL=gemini-3.6-flash
```
* `.env` dosyası yoksa uygulama crash etmez; yalnızca API çağrısı gereken durumlarda anlaşılır hata döndürür.
* `GEMINI_MODEL` tanımlanmazsa varsayılan model devreye girer ve çağrı öncesinde `listModels()` ile doğrulanır.

---

## 6. Güvenlik Prensipleri

1. **`.gitignore` Koruması:** `.env` ve `.env.*` kesinlikle git takibine alınmaz (`!.env.example` istisnadır).
2. **API Key İzolasyonu:** API anahtarı **asla** URL query parametresi olarak gönderilmez; yalnızca `x-goog-api-key` HTTP header'ı üzerinden iletilir.
3. **Log & Hata Sızdırmazlığı:** `GeminiError` ve console çıktıları öncesinde `sanitizeApiKey` mekanizması çalışır, anahtarlar log veya terminal çıktılarına sızmaz.

---

## 7. Test Durumu

- **Toplam Test Sayısı:** 164 unit ve branch testi (`npm test`).
- **Network Bağımlılığı:** Bütün unit/branch testleri sahte `fetch` ve `sleep` (mock) kullanır.
- **Kabul Testi (Acceptance Test):** Gerçek Gemini API (`gemini-3.6-flash`) ile uçtan uca `add-style` ve `new-video` entegrasyonu gerçek görsel ile test edilmiş ve PASS almıştır.

---

## 8. Manuel ve Otomatik Kısımlar

- **Otomatik (Pipeline):** Proje dizin iskeleti, `project.json`, prompt markdown dosyası, Gemini stil kartı analizi, ffmpeg crossfade/loop video işleme, audio birleştirme, ambient miksajı, tracklist ve rapor çıktısı.
- **Manuel (Kullanıcı Yargısı & Medya Üretimi):** 
  - Müzik parçalarının Suno'da üretilmesi.
  - Master frame'in Google AI Studio / Gemini Image üzerinde üretilmesi.
  - Video klibinin Hailuo / Kling üzerinde üretilmesi.
  *(Bu pipeline medya üretimi yapmaz; üretim öncesi hazırlık ve montaj otomasyonu sağlar.)*

---

## 9. Bilinen Sınırlar ve Tasarım Kararları

- **FFmpeg BOM Tuzağı:** `writeTextFile` metinleri her zaman BOM'suz UTF-8 olarak yazar (`ffmpeg` concat demuxer BOM'lu dosyada hata verir).
- **CRLF Temizliği:** Git `core.autocrlf=true` olsa dahi şablon okumalarda `\r\n` satır sonları `\n` olarak normalize edilir.
- **Tek Kırpma / Aspect Crop:** Watermark kırpması (alttan 150px) ve 16:9 oran kesimi hesaplanarak piksel kayıpları raporlanır.

---

## 10. Projeyi Devralan Geliştirici İçin Notlar

1. Bağımlılık eklemeyin; proje Node.js dahili modülleri (`node:fs`, `node:path`, `node:util`, `node:test`) ile tasarlanmıştır.
2. Bir dosya değiştirdiğinizde `npm test` komutunu çalıştırarak 164 testin yeşil kaldığını doğrulayın.
3. Yeni bir CLI veya modül eklerken `StyleError`, `AddStyleError`, `GeminiError` gibi özel sınıf hatalarını kullanın.
