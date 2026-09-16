# Lofi Video Pipeline — Devir ve Mimari Dokümanı (Aşama 7–11)
> **Durum (2026-09-16):** Aşama 11f (albüm üretim zinciri: yay, DNA/varyant prompt, orkestratör) commit'li — bölüm 14.6. Paralel oturumların toparlaması ve açık işler — bölüm 15. apiframe provider (11e) yazıldı — bölüm 14.7. `npm test` 457/457.
> **Durum (2026-09-15):** Aşama 11 (Suno prompt motoru + ingest: 11a, 11b, 11c, 11d) tamamlandı — bölüm 14. `npm test` 310/310 geçiyor.
> **Durum (2026-09-14):** Pipeline Katman 1 (Montaj Otomasyonu: Aşama 1–6) ve Katman 2 (Hazırlık Otomasyonu: Aşama 7a, 7b, 7c, 7d-1, 7d-2) başarıyla tamamlandı. `npm test` 164/164 test geçiyor. Gerçek Gemini API kabul testi doğrulandı.
>
> **Durum (2026-09-15):** Aşama 8 (`npm start` paneli: 8a, 8b, 8c) tamamlandı — bölüm 11. `npm test` 228/228. Panelin gerçek terminalde kabul testi kullanıcıda (bölüm 11.5).
>
> **Durum (2026-09-15):** Aşama 9 (enquirer ile ok tuşlu panel + toplu montaj: 9a–9d) tamamlandı — bölüm 12. `npm test` 248/248. Gerçek terminallerde `npm run tty-check` sonuçları kullanıcıda (bölüm 12.6).
>
> **Durum (2026-09-15):** **Aşama 10 (görsel TUI, ink) BEKLEMEDE** — bölüm 13. 10a commit'li ve korunuyor; 10b başlamadı. Gerçek video üretimi Aşama 9 paneliyle (`npm start`, enquirer) yapılıyor.

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

- **Toplam Test Sayısı:** 457 unit ve branch testi (`npm test`, 2026-09-16; Aşama 7 kapanışında 164, Aşama 8'de 228, Aşama 9'da 248).
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

1. Panelin kullandığı tek bağımlılık `enquirer` 2.4.1 (sabit sürüm, Aşama 9 kararı — bölüm 12). `ink` 7.1.1 / `react` 19.3.0 (+ dev `ink-testing-library` 4.0.0) Aşama 10a'dan kaldı; yalnızca `ui/tui/` ve `tui-check` kullanıyor, Aşama 10 beklemede (bölüm 13). Başka bağımlılık eklemeden önce konuşun; geri kalan her şey Node.js dahili modülleriyle (`node:fs`, `node:path`, `node:util`, `node:test`) yazılmıştır.
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
- **Ctrl+C çökmesi (Node 24+), [enquirer #483](https://github.com/enquirer/enquirer/issues/483) — açık; düzeltme [PR #485](https://github.com/enquirer/enquirer/pull/485) birleştirilmedi.** Kullanıcının `tty-check` 6. adımında yakalandı (`ERR_USE_AFTER_CLOSE: readline was closed`, `keypress.js:217`). Neden: enquirer'ın açtığı readline, `SIGINT` dinleyicisi olmadığı için Ctrl+C'de kendini kapatıyor; enquirer'ın temizleyicisi kapalı arayüzde `rl.pause()` çağırıyor. Hata iptal zincirinin dışında yükseldiği için `run()` sonuçlanmıyor ve süreç çöküyor. İkinci kusur: enquirer "önceki raw mode"u readline raw mode'u açtıktan sonra kaydettiği için çökme yolunda terminal raw modda kalıyor.
  **Çözüm (`ui/prompt.js → guardStart`):** her prompt'un `start()`'ı aynı mantıkla yeniden tanımlanır. Kapalı readline'dan gelen `ERR_USE_AFTER_CLOSE` yutulur (PR #485'in `if (!rl.closed)` eşdeğeri) ve raw mode, dinleyici açılmadan önce okunan değere döndürülür. `node_modules` yamalanmadı (`npm install` siler), `patch-package` eklenmedi. enquirer yeni sürüm çıkarırsa `guardStart` kaldırılabilir mi diye yeniden bakılmalı.
  **Neden testler yakalamamıştı:** adaptör testleri `show: false` modundaydı; bu modda enquirer klavye dinleyicisini hiç açmıyor. `test/unit/ui-prompt.test.js` artık raw moda alınabilen sahte TTY stdin ile gerçek klavye yolunu da sınıyor (Ctrl+C / Esc / ardışık soru, raw mode geri dönüşü); düzeltme kapatılınca bu testler aynı hatayla düşüyor.

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

**Durum (2026-09-15, kullanıcı bildirimi):** 3 terminalden yalnızca **Windows Terminal** tam test edildi. **Klasik Windows PowerShell 5.1 konsolu** ve **Git Bash** hâlâ eksik. Hücre bazında sonuç satırları henüz tabloya işlenmedi. (6. adımda yakalanan Ctrl+C çökmesi `ff6b0df` ile düzeltildi — bölüm 12.2.)

---

## 13. Aşama 10 — Görsel TUI (ink) · ⏸ BEKLEMEDE

**Karar (2026-09-15, kullanıcı):** Aşama 10 askıya alındı. **Sebep:** görsel cila, işlevsel gereklilik değil — Aşama 9 paneli üretim için yeterli. Kullanıcı devam etmek isterse kendisi yeniden açacak; o zamana kadar **10b'ye başlanmaz, Aşama 10 kodu yazılmaz.**

| Parça | Durum |
|---|---|
| 10a — ink prototipi + `npm run tui-check` (`78e015c`) | Commit'li, korunuyor. `ui/tui/` (h, keys, widgets, store, screen), `scripts/tui-check.js` (+ child), testleri `npm test` içinde |
| 10a kapısı — 3 terminalde `tui-check` | Tamamlanmadı (10a commit mesajı: "geçmeden 10b başlamaz") |
| 10b — build.js IPC ilerleme protokolü | Başlamadı |
| 10c — panelin Dashboard'u `ui/tui/screen.js` üzerine | Başlamadı |

**Yeniden açılırsa:** önce 10a kapısı (tui-check, 3 terminal), sonra 10b planı kullanıcıyla konuşulur. `ink` / `react` sürümleri o gün tekrar kontrol edilmeli.

**Etkisi:** `npm start` enquirer panelini açar; ink hiçbir üretim akışında kullanılmıyor.

**Not (2026-09-16, kullanıcı):** ink TUI yerine web/localhost tabanlı bir panel (ACE-Step UI'nin React+Vite yapısına benzer) daha iyi olabilirdi düşüncesi belirtildi. Aşama 10 yeniden açılırsa bu alternatif de değerlendirilecek — henüz karar verilmedi, yalnızca not düşüldü.

## 14. Aşama 11 — Suno Entegrasyonu (Prompt Motoru + Ingest + Üretim) · 11a–11d ✅ · 11e ✅ · 11f ✅

**Karar (2026-09-15):** Aşama 10 (ink TUI) beklemede kaldığı sürece üretim akışı `npm start` (enquirer, Aşama 9) üzerinden devam ediyor. Bu doğrultuda, üretim öncesi manuel adımların (albüm konsepti, Suno prompt yazımı, şarkı indirme) otomasyonu **Aşama 10'un önüne alınarak Aşama 11 olarak** planlandı — TUI görsel cila, bu üretim darboğazını çözmüyor.

Araştırma dokümanı: `docs/research/suno-integration.md` (tam mekanizma analizi, karar tabloları, risk notları orada; burada yalnızca bu projeye uygulanan tasarım kararları var).

### 14.1 Kapsam

Üç alt-aşamaya bölünür, her biri bağımsız commit edilebilir:

| Alt-aşama | İş | Bağımlılık |
|---|---|---|
| 11a | `prep/style-cleaner.js`, `prep/style-exclude.js` — saf fonksiyonlar, Suno Style/Exclude string temizliği. (`prep/style-builder.js` 2026-09-16'da silindi: işlevini 11f `album-prompt.js` devraldı, bkz. bölüm 15) | Yok |
| 11b | `prep/album-planner.js` — Gemini (mevcut `prep/gemini.js` client'ı, `x-goog-api-key`) ile konsept → track listesi → atmosfer arkı; çıktı 11a'dan geçirilir | 11a, `prep/gemini.js` |
| 11c | `prep/suno-ingest.js` — public playlist/song linkinden clip listesi + metadata + mp3 indirme | Yok (bağımsız yazılabilir) |

### 14.2 Mimari kararları (mevcut projeyle tutarlılık)

- Katman aynı: iş mantığı `prep/` altında, saf ve test edilebilir (Aşama 7 kuralı — bölüm 9, not 4 ile aynı).
- Hata sınıfları: `StyleBuildError`, `AlbumPlanError`, `SunoIngestError` — mevcut `StyleError`/`AddStyleError`/`GeminiError` deseniyle aynı satırda (bölüm 10, not 3).
- `prep/suno-ingest.js` HTTP için `node:https`/`fetch` kullanır, ek paket eklenmez (bölüm 10, not 1 — yeni bağımlılık önce konuşulur).
- Panel entegrasyonu: yeni menü adımları `ui/actions.js`'e, enquirer soruları `ui/prompt.js` adaptörü üzerinden — Aşama 9 mimarisine ek dosya değil, mevcut dosyalara fonksiyon eklenir (bölüm 12.3).
- `.env`'e yeni anahtar **eklenmez** — Suno ingest login gerektirmiyor (yalnızca public link), Gemini zaten `GEMINI_API_KEY` kullanıyor.

### 14.3 Ingest tasarımı (11c detay)

- Kabul edilen linkler: `suno.com/song/…`, `suno.com/s/…`, `suno.com/playlist/…`
- Akış: link → public sayfa fetch → embedded JSON'dan clip ID + metadata (title, style, süre) çıkar → `https://cdn1.suno.ai/{clipId}.mp3` indir → proje klasörüne (`audio/`) mevcut isimlendirme kuralına göre yaz
- Rate limit: ardışık indirmeler arası 1-2 sn bekleme
- Kısmi hata: bir track indirilemezse diğerleri devam eder, özet raporda "atlandı (sebep)" olarak listelenir — Aşama 9'daki toplu montaj hata toleransıyla aynı desen (bölüm 12.3, "bir projenin hatası diğerlerini durdurmaz")
- **Ön koşul:** albüm Suno'da public/paylaşılmış olmalı. Değilse bu aşama atlanır, mevcut manuel indirme yolu kullanılır — private şarkı ingest'i (oturum tabanlı kayıt) kapsam dışı bırakıldı, gerek görülürse ayrı doküman edilir.

### 14.4 Test stratejisi

- 11a: saf fonksiyon testleri, mevcut `test/unit/` desenine uyar
- 11b: `prep/gemini.js` testlerindeki gibi sahte `fetch`, network bağımsız
- 11c: sahte HTTP response'larla test edilir; gerçek Suno erişimi yalnızca elle kabul testinde (bölüm 11.5 / 12.6 desenindeki gibi kullanıcı terminalinde doğrulanır, çünkü asistan gerçek Suno hesabına erişemez)

### 14.5 Kapsam dışı (bilinçli olarak ertelendi)

- Suno üretimini API ile tetikleme (resmi API yok, üçüncü parti ücretli/riskli — araştırma dokümanı Bölüm 6)
- Private şarkı ingest / oturum tabanlı kayıt (araştırma dokümanı Bölüm 2.2 / 14.3 ön koşul notu)
- Websocket — gerek yok, HTTP GET yeterli (araştırma dokümanı Bölüm 7)

### 14.6 Aşama 11f — Albüm üretim zinciri · ✅ TAMAM (commit `70733cf`, `57a2eda`)

**Karar (2026-09-16):** Albüm planı → parça parça Suno stil dizesi → üretim (11e provider arayüzü) → indirme tek zincirde. Albüm tutarlılığı (ortak "DNA") ile parçalar arası akış (enerji yayı) ayrı, deterministik katmanlarda. **LLM (Gemini) yalnızca parça başlığı ve 2-5 kelimelik atmosfer üretir; ham Suno prompt'u asla yazmaz.**

| Parça | Dosya | İş |
|---|---|---|
| 11f-1 | `prep/album-arc.js` | Deterministik enerji yayı. `ARC_PHASES`: opening 0–15% (0.45) → descent 15–40% (0.35) → **trough 40–60% (0.20)** → ascent 60–85% (0.45) → resolution 85–100% (0.60); yarı açık `[rangeStart, rangeEnd)`, son faz 1.00'i kapsar. `phaseFor(index, trackCount)` (p = index/(n-1); tek parça → opening), `energyModifiers(energy)` → `{ rhythm, tempo, density }` (eşikler 0.25 / 0.40 / 0.55), `describeArcPhases()` → LLM prompt'larına gömülen tek yay tarifi |
| 11f-2 | `prep/album-prompt.js` | **DNA / varyant ayrımı.** `buildAlbumDna(style)`: stilin `music` bloğundan tür → prodüksiyon → çekirdek enstrümanlar → estetik; her parçada birebir aynı. `buildTrackStyle({ dna, atmosphere, energyMods })`: `"[Instrumental] " + dna + atmosfer + rhythm + tempo + density + ". No vocals, no lyrics. [No Vocals]"` — DNA önde çünkü Suno erken token'lara daha çok ağırlık veriyor. `buildNegativeTags(style)`: `music.exclude`'dan. `SUNO_LIMITS` + `assertSunoLimits`: style 1000 / negative_tags 200 / title 80 (V4.5+/V5/V5.5), aşılırsa `AlbumPromptError` ve **istek gönderilmez** |
| 11f-3 | `prep/album-chain.js` | Orkestratör. `planAlbum({ concept, styleName, trackCount })` → `{ albumTitle, tracks: [{ index, title, atmosphere, phase, styleString, negativeTags }] }`; stil uygun değilse Gemini hiç çağrılmaz. `generateAlbum(tracks, options)`: sırayla `generateSong → waitForSong → downloadAudio`; dosya adı `03-Quiet-Moments.mp3` (`suno-ingest` `sanitizeFilename` kuralı); aynı adlı dosya varsa atlanır (kredi harcanmaz). Parametreler `GENERATION_PARAMS`: styleWeight 0.75, weirdness 0.3, instrumental true; `modelVersion` varsayılan `V5_5`. `formatAlbumSummary` → başarılı / başarısız / atlandı |

**Instrumental üçlü kilit:** `[Instrumental]` stil dizesinin başında + `No vocals, no lyrics. [No Vocals]` sonunda + API'de `instrumental: true`. Tek başına hiçbiri güvenilir değil.

**Yay kararı — ortada zirve değil DİP:** 11b'deki ilk Gemini prompt'u "intro, build, peak, wind-down, outro" diyordu (ortada zirve). Bu yanlış: kullanıcının yayınlanmış albümünde en sessiz nokta tam ortada — **Somnambule, 26:52** (`test/baseline.json` tracklist'i; `test/regression.js` ambient kesitleri de bu noktayı ölçer). Albüm gece→sabah yayı: orta ölçüde açılır, çöker, ortada en durgun an, sonra daha sıcak/parlak bir çözülmeye yükselir. Bu yüzden:
- `album-planner.js` yayı kendisi tarif etmez; `describeArcPhases()` ve `phaseFor` kullanır, parça sayısı tutmazsa hata verir (yay kaymasın).
- `music-planner.js` sahneleri `phase` alanıyla fazlara bağlandı, seçim `phaseFor` ile; trough sahneleri sadeleşti, resolution sahneleri parlaklaştı; fallback prompt'lara `Energy: <tempo>, <density>` eklendi.

**Manifest ve varyantlar:** Suno üretim başına genelde 2 varyant döndürür. İlki indirilir; diğerlerinin URL'i proje klasöründeki `album-manifest.json`'a (`audio/`'nun bir üstü) `alternateUrls` olarak yazılır — kullanıcı beğenmezse elle değiştirir. Manifest her parçadan sonra yeniden yazılır; süreç yarıda kesilse de o ana kadarki kayıt kalır.

**Sözleşme genişlemesi (geriye uyumlu):** `SunoGenerateProvider` request'ine `negativeTags`, `styleWeight`, `weirdness`; RawStatus'a `audioUrls[]` eklendi. `checkStatus`/`waitForSong` artık `audioUrls` da döner (`audioUrl` = ilk varyant).

**Stil şeması:** `styles/<ad>.json` görsel stil dosyası; müzik kimliği opsiyonel `"music": { genre, production, instruments, aesthetic, exclude }` bloğunda (`styles.js` `ROOT_KEYS`'e eklendi, uyarı vermez). **Mevcut üç stilde bu blok yok** — albüm üretimi için kullanıcı doldurmalı; yoksa `AlbumPromptError`.

**Paylaşılan kod:** `suno-ingest.js`'ten `downloadAudio` ve `audioExtension` çıkarıldı; ingest ve zincir aynı indirme kodunu kullanır.

**Kapsam dışı / sonraki:** panel adımı (`ui/actions.js`) henüz yok.

### 14.7 Aşama 11e — apiframe Suno provider · ✅ YAZILDI (canlı kabul testi kullanıcıda)

`prep/providers/apiframe-suno.js` — `SunoGenerateProvider` sözleşmesinin somut hali; sözleşme değişmedi. `createApiframeSunoProvider({ fetchFn, baseUrl, timeoutMs, log })` + varsayılan `apiframeProvider`.

Şema dokümandan doğrulandı (2026-09-16: `apiframe.ai/docs/music/suno.mdx`, `/docs/music.mdx`, `/docs/jobs/get.mdx`):

| | Değer |
|---|---|
| Taban adres | `https://api.apiframe.ai/v2` |
| Üretim | `POST /music/generate` → `202 { jobId, status: "QUEUED" }`; gövde `{ prompt, model: "suno", sunoParams: { custom_mode, instrumental, model_version, title, style, negative_tags, style_weight, weirdness_constraint } }` |
| Durum | `GET /jobs/{id}` → `{ status: QUEUED\|PROCESSING\|COMPLETED\|FAILED, result: { tracks: [{ id, audioUrl, imageUrl, title, tags, duration }] }, error }` |
| Auth | **`X-API-Key: <key>`** (dokümandaki başlık; ilk brifteki "Bearer" dokümanla uyuşmadı) |
| model_version | V4, V4_5, V4_5ALL, V4_5PLUS, V5, V5_5 — varsayılan V5_5, geçersiz değer istek atılmadan reddedilir |
| Maliyet | üretim başına 11 kredi (doküman) |

**Kararlar:**
- İş kimliği dokümanda `jobId` (brifteki `task_id` değil). Ses adresi `result.tracks[].audioUrl`. Şema değişirse diye yedek alanlar (`id`/`job_id`/`task_id`, `audio_url`/`url`/`streamAudioUrl`) denenir; yedek alan kullanılırsa ya da COMPLETED işte adres bulunamazsa `log` ile bildirilir.
- `custom_mode`: style veya title verildiyse `true`. Enstrümantal custom modda `prompt` (zincirde `"[Instrumental] <başlık>"`) Suno tarafından kullanılmaz.
- Hatalar: 401 (key) / 402 (kredi) / 400 kalıcı; 408, 425, 429, 5xx ve ağ hataları `retryable` (Retry-After okunur). `generateSong` hiçbir zaman tekrar denemez — çift kredi harcanmasın.
- apiframe `negative_tags` için 500 karakter kabul ediyor; yerel sınır bilinçli olarak 200 (Suno arayüz sınırı, `SUNO_LIMITS`).
- `afk_…` key biçimi `suno-generate-errors.js` maskeleme kalıplarına eklendi.

**Canlı kabul:** `scripts/album-try.js` (elle; `npm test`'e dahil değil):
1. `lofi/lofi/.env` → `SUNO_GENERATE_API_KEY=afk_...` (`GEMINI_API_KEY` zaten orada)
2. Seçilen stile `"music"` bloğu (bölüm 14.6)
3. `node scripts/album-try.js --style <stil> --concept "<konsept>" --plan-only` → yalnızca Gemini, kredi yok
4. `node scripts/album-try.js --style <stil> --concept "<konsept>" --tracks 1` → 1 üretim (11 kredi), çıktı `videolar/_album-deneme/audio/01-<Başlık>.mp3` + `videolar/_album-deneme/album-manifest.json`

---

## 15. Paralel Oturum Toparlaması ve Açık İşler (2026-09-16)

Dört paralel oturum HANDOFF'u güncelleyemedi (dosya hep başka oturumdaydı); durum burada tek seferde kayıtlı.

| # | İş | Durum |
|---|---|---|
| 1 | Regresyon karşılaştırmasının negatif testi — karşılaştırma gerçek sapmada düşüyor mu? | ✅ **DÜZELTİLDİ** — `2caec8c`: karşılaştırma `test/helpers/regression-compare.js`'e taşındı, `test/unit/regression-compare.test.js` 24 sapmanın yalnızca ilgili kontrolü düşürdüğünü doğruluyor |
| 2 | `crop-check.png` yolu — kırpma onaylanmayınca hata, `finally`'de silinen workspace'teki dosyayı gösteriyordu | ✅ **DÜZELTİLDİ** — `9a8b542`: kare çıktı klasörüne kopyalanıyor, hata o yolla yeniden fırlatılıyor |
| 3 | Suno limit doğrulaması tek kaynak | ✅ Tek kaynak: `prep/album-prompt.js` (`SUNO_LIMITS`, `assertSunoLimits`). Paralel oturumun yazacağı `prep/suno-limits.js` repoda hiç oluşmadı (hiçbir branch/worktree/commit'te yok) — silinecek ikinci kopya olmadı. Dosya ileride gelirse esas o olacak, `album-prompt.js` onu import edecek |
| 4 | `prep/style-builder.js` ölü kod + `describe-style.js`'teki `buildStylePrompt` ile isim çakışması | ✅ `style-builder.js` ve `test/unit/style-builder.test.js` silindi (import eden yer yoktu). `style-cleaner.js` / `style-exclude.js` / `style-errors.js` kullanımda, kaldı |
| 5 | env/secret yardımcılarının tekrarı (env-secrets dedupe) | ⚠ **AÇIK** — bu işin çıktısı repoda bulunamadı. Tekrar hâlâ duruyor: `loadEnv` ve key maskeleme `prep/gemini.js` ile `prep/suno-generate.js` / `prep/suno-generate-errors.js`'te ayrı ayrı. Ortak bir modüle indirilmesi ayrı iş olarak bekliyor |

---

## 16. Yerel Müzik Üretimi Denemesi — ACE-Step-1.5 · ⏹ SONLANDIRILDI (2026-09-16)

ACE-Step-1.5 yerel üretim denendi (2026-09-16), 4GB VRAM'de INT8 sıkıştırma ile kalite ve hız kullanıcı tarafından yetersiz bulundu. Kod tabanına entegre edilmedi, provider yazılmadı. Kurulum `C:\AI\`'de duruyor, tekrar denenmek istenirse hazır.

Tekrar denenecekse bilinmesi gerekenler:
- **Konum:** `C:\AI\ACE-Step-1.5` (motor, commit `ca1e85f`, modeller `checkpoints\` altında ~10 GB) ve `C:\AI\ace-step-ui` (UI, commit `a1fdf91`). Lisans: motor ve model ağırlıkları MIT; UI reposunda LICENSE yok.
- **Başlatma:** `C:\AI\ACE-Step-1.5\.venv\Scripts\acestep.exe --port 8001 --enable-api --server-name 127.0.0.1` (`uv run` kilit kontrolünde takılabiliyor; `setup.bat`'taki `acestep-api` Gradio uçlarını açmadığı için UI ile çalışmaz). UI: `server\` ve kökte `npm run dev`.
- **Ölçüm (RTX 3050 Laptop 4GB, sürücü 566.07):** 60 sn parça ≈ 4.7 dk; bunun ~129 sn'si CPU↔GPU model taşıma, 65 sn diffusion (8 adım), ~20 sn tiled VAE decode. Dil modeli (LM) VRAM yüzünden otomatik kapalı.
- **Bilinen uyumsuzluk:** UI (Haziran) `/generation_wrapper`'a 51 parametre gönderiyor, motor (Ağustos) 72 bekliyor — panelden üretim çalışmıyor. Test motorun REST API'siyle (`/release_task`, `/query_result`) yapıldı.
- **UI'de yapılan yerel değişiklikler (commit'lenmedi):** backend ve Vite `127.0.0.1`'e kısıtlandı (`/api/auth/auto` parolasız token veriyor), `server\.env`'de rastgele `JWT_SECRET` + `ACESTEP_PATH`, `better-sqlite3` 11.10 → 12.11.1 (Node 24 hazır paketi).

---

## 17. Suno tarayıcı botu (Playwright) · ✅ YAZILDI (mock testli, canlı kabul kullanıcıda)

`prep/providers/suno-browser-bot.js` — `SunoGenerateProvider` sözleşmesinin ikinci somut hali; sözleşme ve `suno-generate.js` değişmedi. `createSunoBrowserBot({ launchBrowser, cookie, notify, log, sleepFn, now, …timeouts })` → `{ name, generateSong, checkStatus, close }`.

- **Oturum:** `SUNO_COOKIE` (`.env`, DevTools'taki `Cookie:` başlığı) → `.suno.com` cookie'leri olarak eklenir. Zincire `apiKey` olarak verilir (`resolveSunoCookie()`); böylece `SunoGenerateError` mesajlarından birebir silinir.
- **Akış:** görünür Chromium (`LAUNCH_OPTIONS.headless=false`) → `suno.com/create` → Custom Mode → Style / (More Options →) Exclude styles / Title / Instrumental → Create → Create'ten önce ve sonraki `/song/<uuid>` bağlantılarının farkı = yeni clip'ler. `jobId = "uuid1,uuid2"`.
- **checkStatus:** aynı sayfada her clip'in satır metni okunur; `m:ss` süre → done, hata metni → failed, aksi pending. Ses adresi `https://cdn1.suno.ai/<uuid>.mp3`. İndirme zincirde `suno-ingest.downloadAudio` ile.
- **hCaptcha:** otomatik çözülmez. Görünürse `notify("captcha bekleniyor, elle çöz …")`, kaybolana kadar beklenir (10 dk). Captcha süresi clip bekleme süresinden düşülmez.
- **Seçiciler (`SELECTORS`) canlı sitede DOĞRULANMADI** — ilk canlı denemede ayarlanacak tek yer burası.
- **Bağımlılık:** `playwright` 1.63.0 (sabit). Tarayıcı ikilisi ayrıca: `npx playwright install chromium`.
- **Canlı deneme:** `node scripts/suno-bot-try.js --style "<style>" --title "<başlık>" --negative "<exclude>"` (elle; `npm test`'e dahil değil).
- **Testler:** `test/unit/suno-browser-bot.test.js` + `test/helpers/fake-playwright.js` (sahte Playwright, sanal saat; ağ/tarayıcı yok).
- **Not:** `FORCE_COLOR=3` olan kabukta `regression-compare.test.js` "kırpma filtresi" testi renk kodları yüzünden düşüyor (bu işten bağımsız, önceden var); `FORCE_COLOR=0` ile 481/481.
