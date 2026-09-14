# Lofi Video Pipeline — Devir ve Mimari Dokümanı (Aşama 7–9)

> **Durum (2026-09-14):** Pipeline Katman 1 (Montaj Otomasyonu: Aşama 1–6) ve Katman 2 (Hazırlık Otomasyonu: Aşama 7a, 7b, 7c, 7d-1, 7d-2) başarıyla tamamlandı. `npm test` 164/164 test geçiyor. Gerçek Gemini API kabul testi doğrulandı.
>
> **Durum (2026-09-15):** Aşama 8 (`npm start` paneli: 8a, 8b, 8c) tamamlandı — bölüm 11. `npm test` 228/228. Panelin gerçek terminalde kabul testi kullanıcıda (bölüm 11.5).
>
> **Durum (2026-09-15):** Aşama 9 (enquirer ile ok tuşlu panel + toplu montaj: 9a–9d) tamamlandı — bölüm 12. `npm test` 248/248. Gerçek terminallerde `npm run tty-check` sonuçları kullanıcıda (bölüm 12.6).

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

- **Toplam Test Sayısı:** 248 unit ve branch testi (`npm test`, 2026-09-15; Aşama 7 kapanışında 164, Aşama 8'de 228).
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

1. Tek bağımlılık `enquirer` 2.4.1 (sabit sürüm, Aşama 9 kararı — bölüm 12). Başka bağımlılık eklemeden önce konuşun; geri kalan her şey Node.js dahili modülleriyle (`node:fs`, `node:path`, `node:util`, `node:test`) yazılmıştır.
2. Bir dosya değiştirdiğinizde `npm test` komutunu çalıştırarak 248 testin yeşil kaldığını doğrulayın.
3. Yeni bir CLI veya modül eklerken `StyleError`, `AddStyleError`, `GeminiError` gibi özel sınıf hatalarını kullanın.
4. Panele yeni bir adım eklerken: iş kuralı `prep/`'e (saf ve test edilebilir), soru/komut akışı `ui/actions.js`'e, menü satırı `lofi.js`'e. CLI'yı panelden aynı süreçte çağırmayın (bölüm 11.3).

---

## 11. Aşama 8 — Panel (`npm start`)

### 11.1 Kararlar (kullanıcıyla netleşti)

| Soru | Karar |
|---|---|
| "Hepsi sırayla" arada elle yapılan işler varken nasıl çalışsın? | **Kaldığı yerden devam:** panel proje klasörüne bakıp sıradaki adımı bulur. Durum hiçbir yere kaydedilmez. |
| `clip` alanını kim yazsın? | **Panel** (klip listeden seçilir). `build.js`'in "konfigi değiştirmez" kuralı aynen geçerli. |
| Menü tipi | Numaralı menü (`node:readline`, bağımlılık yok). **Aşama 9'da değişti:** ok tuşlu enquirer menüsü (bölüm 12). |
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
| `ui/prompt.js` | `createPrompter` + `cleanPath`. Aşama 8'de readline (satır kuyruğu, `suspend`/`resume`); **Aşama 9'da enquirer adaptörüyle değiştirildi** (bölüm 12.3) |
| `ui/runner.js` | `runScript` — CLI'yı ayrı süreçte, `stdio: 'inherit'`, `cwd` = repo kökü |
| `ui/actions.js` | Menü akışları; klasör bayrakları (`--videos-dir`, `--ambient-dir`, `--styles-dir`) komutlara her zaman açıkça verilir |
| `lofi.js` | `runPanel` (menü döngüsü, akış hatası paneli düşürmez), `main` (TTY değilse kod 2) |

- **Neden ayrı süreç:** `build.js` çift Ctrl+C'de `process.exit(130)` çağırıyor ve kırpma onayı için stdin'de kendi readline'ını açıyor; `add-style.js` `.env`'i `process.cwd()`'den okuyup `process.env`'i değiştiriyor.
- **Ayrı süreç çalışırken:** panel SIGINT'i yok sayar, komut bitince geri alır. (Aşama 8'de readline ayrıca `suspend` ediliyordu; Aşama 9'da enquirer okuyucuyu her soruda kendisi açıp kapattığı için gerek kalmadı.)
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

---

## 12. Aşama 9 — enquirer ile ok tuşlu panel + toplu montaj

### 12.1 Kararlar (kullanıcıyla netleşti)

| Soru | Karar |
|---|---|
| Menü | **Ok tuşlu seçim** (Claude Code'daki gibi). Aşama 8'deki "bağımlılık yok" kararından **vazgeçildi**. |
| Kütüphane | `enquirer`, **2.4.1 sabit** (`^` yok). Son sürüm 2023-07-28; paket durgun → yalnızca `ui/prompt.js`'in arkasında. |
| Çoklu seçim nerede? | **Toplu montaj:** montaja hazır projeler işaretlenir, `build.js` sırayla çalışır. ("Hangi adımları atlayayım" seçeneği değeri düşük bulundu; mevcut "atla" yeterli.) |
| Onay soruları | "Evet / Hayır" seçimi (enquirer `Confirm` Türkçe `e`'yi false sayıyor). |

### 12.2 enquirer 2.4.1 — kaynak koddan doğrulanan davranışlar
- **Hazır test yardımcısı yok** (pakette yalnızca `index.js`, `index.d.ts`, `lib/`).
- **TTY olmayan stdin** (`PassThrough`, boru): `keypress.listen` "Invalid stream passed" fırlatır. Hata `run()`'ın async executor'ında oluştuğu için **yakalanamaz, süreç çöker**. → `lofi.js` ve `tty-check` enquirer'a gitmeden TTY'yi denetler (`test/branches/tty-guard.test.js`).
- **`show: false`:** klavye dinlenmez; `prompt.once('run')` içinde `prompt.keypress(...)` + `submit()` ile sürülebilir. İmleç gizle/göster kodları yine de `stdout`'a yazılır.
- **Esc ve Ctrl+C ikisi de "cancel":** `run()` Error değil `''` ile reddeder. Tuş `prompt.state.keypress`'te. Adaptör: Esc → geri (`null`), Ctrl+C → `PromptClosedError`.
- **`Select` sonucu seçeneğin `name`'i**, değer değil. `MultiSelect` sonucu `name` dizisi. Adaptör seçenekleri sıra numarasıyla adlandırıp değere eşler.
- **Devre dışı seçenek:** `disabled` metni `hint`'e taşınır; varsayılan ipucu İngilizce `(disabled)` → adaptör `(seçilemez)` verir. Ok tuşları devre dışı öğeyi atlar.
- **`Confirm`** yalnızca `^[ty1]` / `^[fn0]` tanır.
- **Windows** (`process.platform === 'win32'`): simgeler `>`, `√`, `»`; genişlik `sütun − 1`. Multiselect'te açık/kapalı yalnızca renkle ayrılıyor ([enquirer #424](https://github.com/enquirer/enquirer/issues/424)) → gösterge `[x]` / `[ ]`.
- İmleç gizliyken süreç düzeyinde `SIGINT`/`SIGTERM`/`exit` dinleyicisi takılır, prompt kapanınca kaldırılır. Raw modda Ctrl+C sinyal değil tuş olarak gelir.

### 12.3 Mimari
| Dosya | Sorumluluk |
|---|---|
| `ui/prompt.js` | enquirer adaptörü. Arayüz: `ask` (Input), `choose` (Select, `limit: 10`), `chooseMany` (MultiSelect), `confirm` (Evet/Hayır Select), `print`. Esc → `null`/`false`, Ctrl+C → `PromptClosedError`. `cleanPath`. enquirer yalnızca burada. |
| `ui/actions.js` | enquirer'ı bilmez. Yeni: `batchBuild` (toplu montaj). |
| `lofi.js` | Menüye "Toplu montaj". `run` doğrudan `runScript`. TTY denetimi (çökme önlemi). |
| `scripts/tty-check.js` (+ `tty-check-child.js`) | Elle terminal doğrulaması (`npm run tty-check`). |

**Toplu montaj (`batchBuild`):**
- Liste yalnızca `nextStep` = `build` olan projeleri seçilebilir gösterir. `done` projeler listede ama seçilemez; hazır olmayanların yalnızca sayısı basılır.
- Her build'den hemen önce durum yeniden okunur; adım artık `build` değilse proje atlanır.
- Bir projenin hatası diğerlerini durdurmaz. Kod 130 (Ctrl+C) sonrası, kalan proje varsa "kalanlar iptal edilsin mi?" diye sorulur.
- Sonda özet: başarılı / başarısız (kod) / atlandı / iptal.

### 12.4 Test stratejisi
- **Akışlar** (`test/branches/ui-actions.test.js`): `test/helpers/fake-prompter.js` — değer yanıtları (`pick`, `picks`, `BACK`, boolean, metin, fonksiyon). Yanıt bitince, tür uyuşmazsa, seçenek yoksa ya da devre dışıysa anlaşılır hata verir; asılı kalmaz. Prompter uygulamasından bağımsız.
- **Adaptör** (`test/unit/ui-prompt.test.js`): gerçek enquirer, `show: false`, tuşlar `prompt.keypress` ile.
- **TTY koruması** (`test/branches/tty-guard.test.js`): `lofi.js` ve `tty-check` boruya bağlı stdio'da kod 2, stack trace yok.
- **Sınanamayan:** gerçek raw mode ve tuş okuma. `node-pty` yerel derleme isteyen ikinci bir bağımlılık olacağı için bilinçli olarak eklenmedi → `npm run tty-check` ile elle.

### 12.5 Bilinen sınırlar
- Git Bash (mintty) gibi TTY olmayan terminallerde panel açılmaz (kod 2).
- Windows'ta enquirer'ın ASCII simgeleri kullanılır; görünüm farkıdır.
- "Ambient seç" ekranında Esc, "Ambient yok" ile aynı sonucu verir (`choose` ikisinde de `null` döndürüyor).
- Toplu montaj yalnızca nihai videonun varlığına bakar; video yok ama `tracklist.txt` duruyorsa `build.js` `--overwrite` ister ve kod 1 döner (bölüm 11.4 ile aynı sınır). Özette "başarısız (kod 1)" görünür.

### 12.6 Terminal doğrulama (kullanıcı dolduracak — asistan TTY'siz ortamda süremez)
Her ortamda `npm run tty-check`; betiğin sonunda bastığı satır buraya.

| Ortam | Select + kaydırma | MultiSelect | Input (Türkçe) | Esc | Alt süreç devri | Ctrl+C | Çıkıştan sonra echo/imleç |
|---|---|---|---|---|---|---|---|
| Windows PowerShell 5.1 (konsol penceresi) | | | | | | | |
| Windows Terminal (PowerShell) | | | | | | | |
| VS Code entegre terminali (PowerShell) | | | | | | | |
| Git Bash (varsa) — beklenen: "Terminal etkileşimli değil", kod 2 | — | — | — | — | — | — | — |

Ardından panel kabulü: `npm start` → ok tuşlarıyla yeni proje → devam et → Faz 1 → Esc ile geri → Toplu montaj ekranında Boşluk ile işaretleme (gerçek build istenmiyorsa Esc) → menüde Ctrl+C.
