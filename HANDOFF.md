> **NOT (8 Ekim 2026):** Terminal paneli (TUI) kaldırıldı — `lofi.js`, `ui/`, `scripts/tty-check*`, `scripts/tui-check*` ve panel testleri silindi. Bu dokümanda geçen "panel", `npm start` ile açılan menü ve `ui/actions.js` atıfları **tarihsel kayıttır**, bugünkü sistemi anlatmaz. Arayüz artık yalnızca web/Electron.

# Lofi Video Pipeline — Devir ve Mimari Dokümanı (Aşama 7–11)

> **GÜNCEL DURUM İÇİN `CLAUDE.md`'YE BAK.**
>
> Bu dosya bir TARİHÇE (devir dosyası): yazıldığı andaki kararları ve tuzakları
> anlatır, bugünkü yapıyı değil. Aşağıda geçen ama ARTIK OLMAYAN kavramlar:
> müzik stili kütüphanesi (`styles/`), Music Hub ve Music Styles sayfaları,
> master görseli adımı (`faz1`, `resimler/MASTER.png`), kamera açısı promptları
> (`prompts.md`, `prep/prompts.js`).
>
> Ayrıca uzun video artık VARSAYILAN ÇIKTI DEĞİL: `node build.js` 24/7 yayın
> paketini üretir, render `--render` ile istenir.

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

`fix-project` (project.json okunamıyor) → `done` (çıktı var) → `style-references` (custom-generated, STYLE_BLOCK yok) → `faz1` (MASTER yok; elle) → `build` (clip dosyası var + müzik bitti) → `audio` (müzik bitmedi — **klipten bağımsız**; elle) → `clip` (videolar\ altında .mp4 var; seçim) → `faz3` (elle).

Güncel akış sırası (kod ve test `'müzik klipten önce gelir'` ile): stil → master → **müzik → klip** → montaj. `audio` adımındaki projede klip henüz olmayabilir; aşama başına gerçek durum için web API'nin `readiness` alanına bakılır (bölüm 18). Müzik "bitti" kararı `isMusicCompleted` (parça planı varsa plan durumu, yoksa en az bir ses dosyası).

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

## 14. Aşama 11 — Suno Entegrasyonu · ⏹ KALDIRILDI (2026-10-11)

Kullanıcı kararı: müzik artık Suno dışında üretiliyor. Prompt motoru/ingest/üretim sağlayıcıları ve ilgili testler silindi (ayrıntı: kök `CLAUDE.md` "Suno entegrasyonu KALDIRILDI" notu). Müzik `audio/` klasörüne yükleme ya da albüm kütüphanesiyle gelir.

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

## 17. Suno tarayıcı botu · ⏹ KALDIRILDI (2026-10-11)

Bot, `scripts/suno-*.js`, kalıcı tarayıcı profili ve `playwright` bağımlılığı kaldırıldı.

## 18. Web UI backend (`server/`) · ✅ (2026-09-16)

`npm run web` → `server/web-server.js` (yalnızca `127.0.0.1`, varsayılan port 3000; Vite `/api`'yi buraya yönlendirir). Katmanlar: `web-server.js` (HTTP, rota, gövde) → `project-api.js` (adapter) → mevcut domain fonksiyonları. Yeni domain mantığı yok.

| Endpoint | Yeniden kullanılan |
|---|---|
| `GET /api/projects`, `GET /api/projects/:id` (+ `readiness`) | `listProjects`, `inspectProject`, `nextStep`, `isMusicCompleted` |
| `POST /api/projects` | `runNewVideo` (panelin `new-video.js` yolu) |
| `GET /api/library` | `listStyles`, `loadStyle`, `findStyleRef`, `listAmbients` |
| `PUT /api/projects/:id/clip` | `setProjectClip` (panelin `chooseClip`'i) |
| `POST /api/projects/:id/music/complete` | `completeMusicByUser` (`prep/project-file.js`; panelin "Müziği bitir ve devam et"i de bunu çağırır). Web'de koşul: parça planı var ve audio klasöründe en az bir dosya; müzik zaten bittiyse yazmadan 200 |
| `POST`/`GET /api/projects/:id/build` | `build.js` ayrı süreçte (`server/build-jobs.js`), panel gibi |

- **Montaj:** istek beklemez (202); durum bellekte, UI `GET …/build` ile yoklar. Aynı anda tek montaj. Yalnızca `nextStep` = `build`/`done` olan proje; çıktı varsa `overwrite: true` şart. Kırpma değeri project.json'da olduğundan onay sorulmaz. İptal uç noktası yok.
- **Güvenlik (yerel):** Host yalnızca localhost (DNS rebinding); yazan isteklerde `Content-Type: application/json` zorunlu ve Origin localhost olmalı. Kimlik doğrulama yok (kişisel yerel uygulama).
- **Proje oluşturma:** müzik planı `runNewVideo` → `generateMusicPlanAsync`; sunucu `.env` yüklemez, `GEMINI_API_KEY` yalnızca sunucunun ortamında varsa Gemini'ye gider, yoksa deterministik plan. İsim zaten varsa planlamadan önce 409.
- **Yapılmayanlar (panelde var, web'de yok):** faz 2–3 promptlarını gösterme/kopyalama (Faz 1 promptu `GET /api/projects/:id/master` ile var), müzik parçalarını tek tek dosyayla "tamamlandı" işaretleme (web yalnızca aşamayı toptan bitirir), İndirilenler izleme.
- **Testler:** `test/unit/web-api.test.js` (sahte build süreci), `test/unit/web-server.test.js`.
