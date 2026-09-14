# Lofi Video Pipeline — Devir ve Mimari Dokümanı (Aşama 7–8)

> **Durum (2026-09-14):** Pipeline Katman 1 (Montaj Otomasyonu: Aşama 1–6) ve Katman 2 (Hazırlık Otomasyonu: Aşama 7a, 7b, 7c, 7d-1, 7d-2) başarıyla tamamlandı. `npm test` 164/164 test geçiyor. Gerçek Gemini API kabul testi doğrulandı.
>
> **Durum (2026-09-15):** Aşama 8 (`npm start` paneli: 8a, 8b, 8c) tamamlandı — bölüm 11. `npm test` 228/228. Panelin gerçek terminalde kabul testi kullanıcıda (bölüm 11.5).

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

- **Toplam Test Sayısı:** 228 unit ve branch testi (`npm test`, 2026-09-15; Aşama 7 kapanışında 164).
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

- **FFmpeg BOM Tuzağı:** `writeTextFile` varsayılan olarak BOM'suz UTF-8 yazar (`ffmpeg` concat demuxer BOM'lu dosyada hata verir). `tracklist.txt`, rapor ve `project.json` BOM'suzdur.
- **PowerShell okuma sorunu → insan okuduğu dosyalar BOM'lu:** Windows PowerShell 5.1'in `Get-Content`'i BOM'suz UTF-8'i ANSI kod sayfasıyla (cp1254) okuyup `â€”`, `Ã¼` gösterir. Bu yüzden `new-video.js` `prompts.md` ve `STYLE_BLOCK.txt`'yi `writeTextFile(..., { bom: true })` ile yazar. Eski (BOM'suz) dosyaları okumak için: `Get-Content <dosya> -Encoding UTF8`.
- **CRLF Temizliği:** Git `core.autocrlf=true` olsa dahi şablon okumalarda `\r\n` satır sonları `\n` olarak normalize edilir.
- **Tek Kırpma / Aspect Crop:** Watermark kırpması (alttan 150px) ve 16:9 oran kesimi hesaplanarak piksel kayıpları raporlanır.

---

## 10. Projeyi Devralan Geliştirici İçin Notlar

1. Bağımlılık eklemeyin; proje Node.js dahili modülleri (`node:fs`, `node:path`, `node:util`, `node:test`) ile tasarlanmıştır.
2. Bir dosya değiştirdiğinizde `npm test` komutunu çalıştırarak 228 testin yeşil kaldığını doğrulayın.
3. Yeni bir CLI veya modül eklerken `StyleError`, `AddStyleError`, `GeminiError` gibi özel sınıf hatalarını kullanın.
4. Panele yeni bir adım eklerken: iş kuralı `prep/`'e (saf ve test edilebilir), soru/komut akışı `ui/actions.js`'e, menü satırı `lofi.js`'e. CLI'yı panelden aynı süreçte çağırmayın (bölüm 11.3).

---

## 11. Aşama 8 — Panel (`npm start`)

### 11.1 Kararlar (kullanıcıyla netleşti)

| Soru | Karar |
|---|---|
| "Hepsi sırayla" arada elle yapılan işler varken nasıl çalışsın? | **Kaldığı yerden devam:** panel proje klasörüne bakıp sıradaki adımı bulur. Durum hiçbir yere kaydedilmez. |
| `clip` alanını kim yazsın? | **Panel** (klip listeden seçilir). `build.js`'in "konfigi değiştirmez" kuralı aynen geçerli. |
| Menü tipi | Numaralı menü (`node:readline`, bağımlılık yok). |
| Açılış komutu | Repo içinde `npm start` (`node lofi.js`). Global kurulum yok. |

### 11.2 Sıradaki adımın belirlenmesi (`prep/project-status.js → nextStep`)

Kanıta göre **sondan başa** bakılır; elle yapılmış ama işaretlenmemiş adım tekrar istenmez:

`fix-project` (project.json okunamıyor) → `done` (çıktı var) → `build` (clip dosyası var + parça var) → `audio` (clip var, parça yok; elle) → `clip` (videolar\ altında .mp4 var; seçim) → `faz3` (`resimler\MASTER.*` var; elle) → `faz1` (elle).

- Faz 2 hiçbir adımı engellemez.
- `Master1.jpg` gibi açı varyantları MASTER sayılmaz.
- Oturumda yalnızca `faz1`/`faz3` atlanabilir (`SKIPPABLE_STEPS`). İkisi de atlanır ve klip yoksa adım "Klip bekleniyor" olur; bu adım atlanamaz.

### 11.3 Mimari

| Dosya | Sorumluluk |
|---|---|
| `prep/project-status.js` | `inspectProject` (yalnızca okur), `nextStep` (saf), `listProjects` (son değişen en üstte) |
| `prep/project-file.js` | `setProjectClip` — yalnızca `clip`; proje dışı ya da olmayan dosya reddedilir; `./videolar/x.mp4` biçimi |
| `ui/prompt.js` | `createPrompter` (kendi satır kuyruğu, `ask`/`choose`/`confirm`, `suspend`/`resume`, EOF ve menüde Ctrl+C → `PromptClosedError`), `cleanPath` |
| `ui/runner.js` | `runScript` — CLI'yı ayrı süreçte, `stdio: 'inherit'`, `cwd` = repo kökü |
| `ui/actions.js` | Menü akışları; klasör bayrakları (`--videos-dir`, `--ambient-dir`, `--styles-dir`) komutlara her zaman açıkça verilir |
| `lofi.js` | `runPanel` (menü döngüsü, akış hatası paneli düşürmez), `main` (TTY değilse kod 2) |

- **Neden ayrı süreç:** `build.js` çift Ctrl+C'de `process.exit(130)` çağırıyor ve kırpma onayı için stdin'de kendi readline'ını açıyor; `add-style.js` `.env`'i `process.cwd()`'den okuyup `process.env`'i değiştiriyor.
- **Ayrı süreç çalışırken:** panel readline'ı bırakır (`suspend`), SIGINT'i yok sayar. Komut bitince ikisi de geri alınır.
- **Aşama 8'de `new-video.js`'e eklenen:** `--styles-dir` bayrağı.

### 11.4 Bilinen sınırlar
- "Bu oturumda atla" panel kapanınca unutulur (bilinçli: durum saklanmaz).
- `setProjectClip` project.json'u 2 boşluk girintiyle yeniden yazar; elle verilmiş özel biçim kaybolur.
- Faz 1 çıktısının adı `resimler\MASTER.<uzantı>` olmalı; farklı adla kaydedilirse panel Faz 1'de kalır ("Bu oturumda atla" ile geçilebilir).
- Montajdan önce panel yalnızca nihai videonun varlığına bakar. Video yok ama `tracklist.txt` duruyorsa `build.js` `--overwrite` ister ve çıkış 1 döner; panel başarısızlığı gösterip menüye döner.
- Panel gerçek bir terminal (TTY) ister; testler TTY'siz, sahte akışla yürür.

### 11.5 Kabul (kullanıcının terminalinde — asistan TTY'siz ortamda paneli süremedi)
1. `npm start` → menü açılıyor.
2. `2` → `video3-Panel-Test`, stil, ambient → "Bu projeyle devam et?" → Faz 1 talimatı görünüyor.
3. Proje klasöründe: `ni resimler\MASTER.png, videolar\in.mp4` → panelde `1` (Tekrar kontrol et) → klip onayı → `project.json`'da `"clip": "./videolar/in.mp4"`.
4. `audio\` boş → Suno talimatı, "atla" seçeneği yok → `0`.
5. Ana menüde `6` → durum listesi doğru.
6. Menüde Ctrl+C → panel kapanıyor.
7. `videolar\video3-Panel-Test` elle siliniyor.

### 11.6 Kapsam dışı (not edildi, dokunulmadı)
- `prep/gemini.js`: `DEFAULT_GEMINI_MODEL = 'gemini-1.5-flash'` tahminle yazılmış bir varsayılan; `.env`'de `GEMINI_MODEL` yoksa bu model istenir (`listModels` doğrulaması bulamazsa hata). `MAX_RETRIES = 3` (Aşama 7 planında 5 idi).
