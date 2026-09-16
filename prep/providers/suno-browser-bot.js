/**
 * Suno tarayıcı botu — SunoGenerateProvider sözleşmesinin Playwright ile somut hali.
 *
 * Akış (görünür Chromium, kalıcı profil):
 *   launchPersistentContext(.auth/suno-profile) → suno.com/create
 *   → oturum yoksa: SUNO_COOKIE yedeği (verildiyse) → yine yoksa elle giriş beklenir
 *   → Custom Mode (Gelişmiş sekme) → style / exclude styles / başlık / instrumental → Create
 *   → yeni /song/<uuid> bağlantıları DOM'dan yakalanır → jobId = "uuid,uuid"
 *   checkStatus: aynı sayfada her clip satırının metni okunur (süre görünür → done).
 *
 * Oturum profilde kalır: ilk kez `node scripts/suno-login.js` ile elle giriş yapılır.
 * Clerk'in asıl oturum cookie'si (__client, auth.suno.com, HttpOnly) Cookie
 * başlığında görünmediği için SUNO_COOKIE tek başına genelde yetmez; yalnızca yedek.
 *
 * hCaptcha: OTOMATİK ÇÖZÜLMEZ. Çerçeve görünürse kullanıcıya bildirilir ve
 * elle çözülene kadar beklenir (captchaTimeoutMs).
 *
 * Seçiciler 2026-09-16'da canlı sitede (Türkçe arayüz) kısmen doğrulandı; bkz. SELECTORS.
 * suno.com arayüzü değiştikçe yalnızca SELECTORS güncellenir. Bekleme/backoff
 * prep/suno-generate.js'te, indirme prep/suno-ingest.js downloadAudio'da kalır.
 *
 * Cookie verilirse suno-generate'e `apiKey` olarak geçer: böylece hata mesajlarından
 * birebir silinir (SunoGenerateError secrets). Asla loglanmaz. Cookie yoksa
 * suno-generate'in dolu apiKey şartı PROFILE_API_KEY yer tutucusuyla karşılanır.
 */

import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import { SunoGenerateError } from '../suno-generate-errors.js';
import { loadEnv } from '../suno-generate.js';

export const SUNO_ORIGIN = 'https://suno.com';
export const SUNO_CREATE_URL = `${SUNO_ORIGIN}/create`;
/** Suno'nun kendi clip ses adresi deseni. */
export const SUNO_AUDIO_URL = (clipId) => `https://cdn1.suno.ai/${clipId}.mp3`;

/** Görünür tarayıcı: captcha ve giriş elle yapılabilsin. */
export const LAUNCH_OPTIONS = Object.freeze({ headless: false });

/** Kalıcı profil klasörü (repo köküne göre); SUNO_PROFILE_DIR ile değiştirilebilir. Git'e girmez (.gitignore: .auth/). */
export const DEFAULT_PROFILE_DIR = '.auth/suno-profile';

/**
 * Cookie yokken suno-generate'in zorunlu apiKey'ini karşılayan yer tutucu.
 * Bot bu değeri cookie saymaz.
 */
export const PROFILE_API_KEY = '<suno-browser-profile>';

export const PAGE_TIMEOUT_MS = 45000;
/** Giriş düğmesi göründükten sonra formun yine de gelmesi için kısa pay (hydration). */
export const LOGIN_GRACE_MS = 5000;
/** Kullanıcının tarayıcıda elle giriş yapması için süre. */
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
/** Mod sekmeleri geldikten sonra style alanının render edilmesi için süre (yanlış sekmeye tıklamamak için). */
export const FORM_SETTLE_MS = 5000;
/** Create'ten sonra yeni clip'lerin listede görünmesi için süre (captcha beklemesi hariç). */
export const CLIP_APPEAR_TIMEOUT_MS = 120000;
export const CAPTCHA_TIMEOUT_MS = 10 * 60 * 1000;
export const POLL_INTERVAL_MS = 2000;
/** Suno bir üretimde genelde iki varyant çıkarır. */
export const EXPECTED_VARIANTS = 2;

export const CAPTCHA_MESSAGE = 'captcha bekleniyor, elle çöz — tarayıcı penceresinde captcha\'yı çözünce bot kendiliğinden devam edecek.';
export const LOGIN_MESSAGE = 'Suno oturumu açık değil — açılan tarayıcı penceresinde Suno\'ya giriş yap; giriş tamamlanınca bot kendiliğinden devam edecek.';

/**
 * Tüm DOM bağımlılığı burada. Virgüllü seçicilerde DOM sırasında ilk eşleşen kullanılır.
 * [canlı] = 2026-09-16'da suno.com'da (Türkçe arayüz, oturumlu/oturumsuz) DOM'dan doğrulandı.
 * :visible → Suno aynı öğeyi gizli kopyasıyla da render ediyor (ör. iki "Log in", ilki gizli); first() gizliyi seçmesin.
 */
export const SELECTORS = Object.freeze({
  /** [canlı] Basit/Gelişmiş mod sekmeleri (tek tablist); form hazır işareti. Metne bağlı değil. */
  formModeTab: '[role="tablist"] [role="tab"]:visible',
  /** [canlı] Custom Mode = style alanı görünmüyorken seçili olmayan sekme (Basit modda style alanı yok). */
  inactiveFormModeTab: '[role="tablist"] [role="tab"][aria-selected="false"]:visible',
  /** [canlı] Oturumsuz sayfadaki giriş düğmesi; öznitelik yok, yalnızca metin (en: "Log in", tr: "Giriş yap"). */
  loginButton: ':is(button, a):visible:has-text("Log in"), :is(button, a):visible:has-text("Giriş yap")',
  /** [canlı] Style kutusu data-testid'li sarmalayıcının içinde; placeholder önerilen stillerdir, dile bağlı değil. */
  styleInput: '[data-testid="create-form-styles-wrapper"] textarea:visible',
  lyricsInput: 'textarea[placeholder*="lyrics" i], textarea[aria-label*="lyrics" i]',
  titleInput: 'input[placeholder="Song Title (Optional)"]:visible, input[placeholder*="Song Title" i]:visible, input[placeholder*="title" i]:visible, input[aria-label*="title" i]:visible',
  moreOptions: 'button:has-text("More Options"), button:has-text("Advanced Options")',
  negativeTagsInput: 'input[placeholder*="exclude" i], textarea[placeholder*="exclude" i]',
  instrumentalToggle: 'button:visible[data-selected]:has-text("Instrumental"), button:visible[aria-pressed]:has-text("Instrumental"), button:visible[data-selected]:has-text("Off"), [role="switch"]:visible[aria-label*="instrumental" i], button:visible[aria-label*="instrumental" i]',
  /** [canlı: tr "Şarkı oluştur"] Sayfada ayrıca aria-label="Üret" (söz yazarı) düğmesi var; ona dokunulmaz. */
  createButton: 'button[aria-label="Create song"]:visible, button[aria-label="Şarkı oluştur"]:visible',
  captchaFrame: 'iframe[src*="hcaptcha.com"]',
  songLink: 'a[href*="/song/"]',
});

const SIGN_IN_PATH = /\/(sign-?in|login)\b/i;
const UUID_IN_HREF = /\/song\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i;
const ACTIVE_VALUES = new Set(['true', 'on', 'checked', 'active']);
const FAILED_TEXT = /\b(failed|error|couldn['’]?t|unable to generate|moderat)/i;
const DURATION_TEXT = /\b\d{1,2}:\d{2}\b/;

/**
 * SUNO_COOKIE ortamdan.
 * @param {object} [env]
 * @returns {string | undefined}
 */
export function getSunoCookie(env = process.env) {
  return env.SUNO_COOKIE;
}

/**
 * Cookie'yi çözer (gemini.js/suno-generate.js'teki loadEnv deseni); yoksa anlaşılır hata.
 * required=false: kalıcı profil ana yöntem olduğunda cookie yedektir, yoksa undefined.
 * @param {{ cookie?: string, env?: object, repoRoot?: string, required?: boolean }} [options]
 * @returns {string | undefined}
 */
export function resolveSunoCookie({ cookie, env, repoRoot, required = true } = {}) {
  if (!cookie && !env) loadEnv(repoRoot || process.cwd());
  const value = (cookie || getSunoCookie(env || process.env) || '').trim();
  if (!value && !required) return undefined;
  if (!value) {
    throw new SunoGenerateError(
      'SUNO_COOKIE bulunamadı. suno.com\'da oturum açıkken bir isteğin Cookie başlığını .env dosyasına SUNO_COOKIE= olarak ekleyin.',
      { status: 401 },
    );
  }
  return value;
}

/**
 * Kalıcı profil klasörü: SUNO_PROFILE_DIR (göreliyse repo köküne göre) ya da DEFAULT_PROFILE_DIR.
 * @param {{ env?: object, repoRoot?: string }} [options]
 * @returns {string} mutlak yol
 */
export function resolveProfileDir({ env, repoRoot } = {}) {
  const root = repoRoot || process.cwd();
  if (!env) loadEnv(root);
  const configured = ((env || process.env).SUNO_PROFILE_DIR || '').trim();
  return resolve(root, configured || DEFAULT_PROFILE_DIR);
}

/**
 * "a=1; b=2" biçimindeki Cookie başlığını Playwright cookie listesine çevirir.
 * Değerde "=" olabilir; yalnızca ilk "=" ayırıcıdır.
 *
 * @param {string} header
 * @param {string} [domain]
 * @returns {Array<{ name: string, value: string, domain: string, path: string, secure: boolean, sameSite: 'Lax' }>}
 */
export function parseCookieHeader(header, domain = '.suno.com') {
  if (typeof header !== 'string') return [];
  return header
    .replace(/^cookie:\s*/i, '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=');
      return eq > 0 ? { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() } : null;
    })
    .filter((c) => c && c.name)
    .map(({ name, value }) => ({ name, value, domain, path: '/', secure: true, sameSite: 'Lax' }));
}

/**
 * href listesinden clip id'leri (sıra korunur, tekrarsız).
 * @param {Array<string|null>} hrefs
 * @returns {string[]}
 */
export function extractClipIds(hrefs) {
  const ids = [];
  for (const href of hrefs ?? []) {
    const id = typeof href === 'string' ? href.match(UUID_IN_HREF)?.[1]?.toLowerCase() : null;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Clip satırının görünen metninden durum. Süre (m:ss) görünüyorsa ses hazırdır.
 * @param {{ found: boolean, text?: string }} row
 * @returns {'pending'|'done'|'failed'}
 */
export function classifyClipRow(row) {
  if (!row?.found) return 'pending';
  const text = row.text ?? '';
  if (FAILED_TEXT.test(text)) return 'failed';
  if (DURATION_TEXT.test(text)) return 'done';
  return 'pending';
}

/**
 * Varyant durumlarını tek bir ham duruma indirger:
 * bekleyen varsa pending; hiç biten yoksa failed; aksi halde done (bitenlerin URL'leri).
 *
 * @param {Array<{ id: string, state: 'pending'|'done'|'failed' }>} clips
 * @returns {{ status: string, audioUrls: string[], error?: string }}
 */
export function summarizeClips(clips) {
  if (clips.length === 0 || clips.some((c) => c.state === 'pending')) return { status: 'pending', audioUrls: [] };
  const done = clips.filter((c) => c.state === 'done');
  if (done.length === 0) return { status: 'failed', audioUrls: [], error: 'Suno tüm varyantlarda üretim hatası gösterdi.' };
  return { status: 'done', audioUrls: done.map((c) => SUNO_AUDIO_URL(c.id)) };
}

function parseJobId(jobId) {
  const ids = String(jobId).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (ids.length === 0 || ids.some((id) => !/^[a-f0-9-]{36}$/.test(id))) {
    throw new SunoGenerateError(`Geçersiz bot jobId: "${jobId}" (virgülle ayrılmış clip uuid'leri beklenir).`, { jobId });
  }
  return ids;
}

/**
 * Gerçek tarayıcı: yalnızca canlı kullanımda yüklenir (testler launchContext verir).
 * Kalıcı profil: oturum cookie'leri klasörde kalır. Aynı klasörü iki süreç aynı anda açamaz.
 */
async function launchPersistentChromium(profileDir) {
  const { chromium } = await import('playwright');
  await mkdir(profileDir, { recursive: true });
  return chromium.launchPersistentContext(profileDir, LAUNCH_OPTIONS);
}

/**
 * Tarayıcıda çalışır: her clip id için bağlantının bulunduğu satırın metni.
 * Node'da test edilmez (mock page.evaluate); sınıflandırma classifyClipRow'da.
 */
function readClipRowsInPage({ ids, songLink }) {
  return ids.map((id) => {
    const anchor = [...document.querySelectorAll(songLink)].find((a) => (a.getAttribute('href') || '').toLowerCase().includes(id));
    if (!anchor) return { id, found: false };
    let row = anchor.closest('[data-clip-id], [role="row"], [data-testid*="clip" i], li');
    if (!row) {
      row = anchor;
      for (let i = 0; i < 4 && row.parentElement; i++) row = row.parentElement;
    }
    return { id, found: true, text: row.innerText || row.textContent || '' };
  });
}

/**
 * @param {object} [deps]
 * @param {(profileDir: string) => Promise<object>} [deps.launchContext] Playwright kalıcı BrowserContext döndürür
 * @param {string} [deps.profileDir] verilmezse SUNO_PROFILE_DIR, o da yoksa DEFAULT_PROFILE_DIR
 * @param {string} [deps.cookie] yedek cookie; verilmezse context.apiKey, o da yoksa SUNO_COOKIE (hiçbiri şart değil)
 * @param {(message: string) => void} [deps.notify] kullanıcıya görünen mesajlar (captcha, giriş)
 * @param {(message: string) => void} [deps.log] ayrıntı/sapma bildirimleri
 * @param {typeof setTimeout} [deps.sleepFn]
 * @param {() => number} [deps.now]
 * @param {number} [deps.pageTimeoutMs]
 * @param {number} [deps.clipTimeoutMs]
 * @param {number} [deps.captchaTimeoutMs]
 * @param {number} [deps.loginTimeoutMs]
 * @param {number} [deps.pollIntervalMs]
 * @returns {import('../suno-generate-provider.js').SunoGenerateProvider & {
 *   login: (options?: { signal?: AbortSignal }) => Promise<void>,
 *   close: () => Promise<void>,
 * }}
 */
export function createSunoBrowserBot({
  launchContext = launchPersistentChromium,
  profileDir,
  cookie: fixedCookie,
  notify = (message) => console.log(`[suno-bot] ${message}`),
  log = (message) => console.warn(`[suno-bot] ${message}`),
  sleepFn,
  now = Date.now,
  pageTimeoutMs = PAGE_TIMEOUT_MS,
  clipTimeoutMs = CLIP_APPEAR_TIMEOUT_MS,
  captchaTimeoutMs = CAPTCHA_TIMEOUT_MS,
  loginTimeoutMs = LOGIN_TIMEOUT_MS,
  pollIntervalMs = POLL_INTERVAL_MS,
} = {}) {
  /** @type {{ context: any, page: any } | null} */
  let session = null;

  const sleep = (ms) => new Promise((done) => (sleepFn ? sleepFn(done, ms) : setTimeout(done, ms)));
  const first = (selector) => session.page.locator(selector).first();
  const settle = (locator, timeout) => locator.waitFor({ state: 'visible', timeout }).then(() => true, () => false);

  async function isVisible(selector) {
    const locator = first(selector);
    return (await locator.count()) > 0 && locator.isVisible();
  }

  /** Yedek cookie: sabit > apiKey (yer tutucu değilse) > SUNO_COOKIE; yoksa undefined (profil yeter). */
  function resolveCookie(apiKey) {
    const given = fixedCookie || (apiKey === PROFILE_API_KEY ? undefined : apiKey);
    return resolveSunoCookie({ cookie: given, required: false });
  }

  /** Verilen cookie tarayıcı açılmadan doğrulanır; cookie yoksa boş liste. */
  function cookiesFrom(cookie) {
    if (!cookie) return [];
    const cookies = parseCookieHeader(cookie);
    if (cookies.length === 0) {
      throw new SunoGenerateError('SUNO_COOKIE ayrıştırılamadı ("ad=değer; ad2=değer2" biçimi beklenir).', { secrets: [cookie] });
    }
    return cookies;
  }

  async function openSession() {
    if (session) return session;
    const context = await launchContext(profileDir || resolveProfileDir());
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      session = { context, page };
    } catch (err) {
      await context.close().catch(() => {});
      throw err;
    }
    return session;
  }

  const onCreatePage = () => String(session.page.url()).startsWith(SUNO_CREATE_URL);

  async function gotoCreate() {
    await session.page.goto(SUNO_CREATE_URL, { waitUntil: 'domcontentloaded', timeout: pageTimeoutMs });
  }

  /**
   * Create formunu hazırlar: profil oturumu → (varsa) cookie yedeği → elle giriş.
   * @param {object[]} cookies cookiesFrom çıktısı
   */
  async function ensureCreatePage(cookies, signal) {
    await openSession();
    if (!onCreatePage()) await gotoCreate();
    if (await waitForCreateForm(signal)) return;

    if (cookies.length > 0) {
      log('profilde Suno oturumu yok; SUNO_COOKIE yedeği deneniyor.');
      await session.context.addCookies(cookies);
      await gotoCreate();
      if (await waitForCreateForm(signal)) return;
    }
    await waitForManualLogin(signal);
  }

  /**
   * SPA hydration: mod sekmeleri, giriş düğmesi ya da captcha görünene kadar bekler.
   * URL tek başına yetmez (oturumsuz sayfa /create'te de kalabilir, / adresine de gidebilir).
   * @returns {Promise<boolean>} form hazır mı (false → oturum yok)
   */
  async function waitForCreateForm(signal) {
    const form = first(SELECTORS.formModeTab);
    const anySignal = form.or(first(SELECTORS.loginButton)).or(first(SELECTORS.captchaFrame)).first();
    if (!(await settle(anySignal, pageTimeoutMs))) {
      throw new SunoGenerateError(`Suno create formu ${Math.round(pageTimeoutMs / 1000)} sn içinde yüklenmedi (seçici değişmiş olabilir: ${SELECTORS.formModeTab}).`);
    }
    if (await waitWhileCaptcha(signal)) return waitForCreateForm(signal);
    if (await form.isVisible()) return true;
    // Giriş düğmesi hydration sırasında kısa süre görünebilir: form için kısa pay.
    return settle(form, LOGIN_GRACE_MS);
  }

  /** Kullanıcı tarayıcıda elle giriş yapana kadar bekler; giriş sonrası suno.com'da başka sayfadaysa create'e döner. */
  async function waitForManualLogin(signal) {
    notify(LOGIN_MESSAGE);
    const deadline = now() + loginTimeoutMs;
    let loggedInChecks = 0;
    while (true) {
      signal?.throwIfAborted();
      await waitWhileCaptcha(signal);
      if (await isVisible(SELECTORS.formModeTab)) {
        notify('Suno oturumu açık, devam ediliyor.');
        return;
      }
      if (now() >= deadline) break;
      // Art arda iki bakışta giriş düğmesi yoksa (hydration değil) giriş tamamlanmıştır.
      loggedInChecks = (await leftLoginElsewhere()) ? loggedInChecks + 1 : 0;
      if (loggedInChecks >= 2) {
        loggedInChecks = 0;
        await gotoCreate();
      }
      await sleep(pollIntervalMs);
    }
    throw new SunoGenerateError(
      `Suno oturumu açılmadı: ${Math.round(loginTimeoutMs / 60000)} dakika içinde giriş yapılmadı. Önce "node scripts/suno-login.js" ile tarayıcı profilinde oturum aç.`,
      { status: 401 },
    );
  }

  /** suno.com'un create dışı bir sayfasında ve giriş düğmesi yok mu (Google/Clerk giriş sayfalarına dokunulmaz). */
  async function leftLoginElsewhere() {
    let url;
    try {
      url = new URL(String(session.page.url()));
    } catch {
      return false;
    }
    if (url.hostname !== 'suno.com' || onCreatePage() || SIGN_IN_PATH.test(url.pathname)) return false;
    return !(await isVisible(SELECTORS.loginButton));
  }

  /**
   * Captcha görünürse kullanıcıyı bir kez uyarır ve kaybolana kadar bekler.
   * @returns {Promise<boolean>} captcha görüldü mü
   */
  async function waitWhileCaptcha(signal) {
    if (!(await isVisible(SELECTORS.captchaFrame))) return false;
    notify(CAPTCHA_MESSAGE);
    const deadline = now() + captchaTimeoutMs;
    while (await isVisible(SELECTORS.captchaFrame)) {
      signal?.throwIfAborted();
      if (now() >= deadline) {
        throw new SunoGenerateError(`Captcha ${Math.round(captchaTimeoutMs / 60000)} dakika içinde çözülmedi.`);
      }
      await sleep(pollIntervalMs);
    }
    notify('captcha geçildi, devam ediliyor.');
    return true;
  }

  /**
   * Custom Mode = style alanının göründüğü sekme (Basit modda style alanı yok).
   * Style alanı render için kısa süre beklenir; yine yoksa seçili olmayan sekmeye geçilir.
   * Sekme metnine/sırasına bağlı değil.
   */
  async function ensureCustomMode() {
    if (await settle(first(SELECTORS.styleInput), FORM_SETTLE_MS)) return;
    await setToggle(SELECTORS.inactiveFormModeTab, true, 'Custom Mode (Gelişmiş sekmesi)');
  }

  /** aria-pressed/aria-checked/aria-selected/data-state/data-selected ile açık mı; değilse tıklar. Okunamazsa hata fırlatır. */
  async function setToggle(selector, wanted, label) {
    if (!(await isVisible(selector))) {
      throw new SunoGenerateError(`Suno sayfasında ${label} düğmesi bulunamadı (seçici: ${selector}).`);
    }
    const locator = first(selector);
    let current = null;
    for (const attr of ['aria-pressed', 'aria-checked', 'aria-selected', 'data-state', 'data-selected']) {
      const value = await locator.getAttribute(attr);
      if (value !== null && value !== undefined) {
        current = ACTIVE_VALUES.has(String(value).toLowerCase());
        break;
      }
    }
    if (current === null) {
      throw new SunoGenerateError(`${label} durumunu doğrulayamadım; güvenli şekilde duruyorum (seçici: ${selector}).`);
    }
    if (current !== wanted) await locator.click();
  }

  async function fillRequired(selector, value, label) {
    const locator = first(selector);
    try {
      await locator.waitFor({ state: 'visible', timeout: pageTimeoutMs });
    } catch {
      throw new SunoGenerateError(`Suno sayfasında ${label} alanı bulunamadı (seçici değişmiş olabilir: ${selector}).`);
    }
    await locator.fill(value);
  }

  async function fillOptional(selector, value, label) {
    if (!value) return;
    if (!(await isVisible(selector))) {
      log(`${label} alanı görünmüyor; atlandı.`);
      return;
    }
    await first(selector).fill(value);
  }

  async function listClipIds() {
    return extractClipIds(await session.page.$$eval(SELECTORS.songLink, (els) => els.map((el) => el.getAttribute('href'))));
  }

  /** Create sonrası yeni clip'leri bekler; araya captcha girerse süre ona eklenmez. */
  async function waitForNewClips(before, signal) {
    let deadline = now() + clipTimeoutMs;
    let found = [];
    while (true) {
      signal?.throwIfAborted();
      const started = now();
      if (await waitWhileCaptcha(signal)) deadline += now() - started;

      found = (await listClipIds()).filter((id) => !before.has(id));
      if (found.length >= EXPECTED_VARIANTS) return found.slice(0, EXPECTED_VARIANTS);
      if (now() >= deadline) break;
      await sleep(pollIntervalMs);
    }
    if (found.length > 0) {
      log(`yalnızca ${found.length} yeni clip göründü; onunla devam ediliyor.`);
      return found;
    }
    throw new SunoGenerateError('Create sonrası Suno listesinde yeni şarkı görünmedi (kredi bitmiş ya da seçiciler değişmiş olabilir).');
  }

  return {
    name: 'suno-browser',

    async generateSong({ prompt, style, title, instrumental, negativeTags }, { apiKey, signal } = {}) {
      const cookie = resolveCookie(apiKey);
      signal?.throwIfAborted();
      if (!style) throw new SunoGenerateError('Suno botu Custom Mode kullanır: style zorunlu.');
      const cookies = cookiesFrom(cookie);

      try {
        await ensureCreatePage(cookies, signal);
        await ensureCustomMode();
        await fillRequired(SELECTORS.styleInput, style, 'Style');

        if (negativeTags && !(await isVisible(SELECTORS.negativeTagsInput)) && (await isVisible(SELECTORS.moreOptions))) {
          await first(SELECTORS.moreOptions).click();
        }
        if (negativeTags) {
          if (await isVisible(SELECTORS.negativeTagsInput)) {
            await fillRequired(SELECTORS.negativeTagsInput, negativeTags, 'Exclude styles (negative tags)');
          } else {
            log('[suno-bot] Exclude Styles mevcut UI\'da yok; negative tags atlandı.');
          }
        }

        await fillOptional(SELECTORS.titleInput, title, 'Title');
        if (instrumental !== undefined) await setToggle(SELECTORS.instrumentalToggle, Boolean(instrumental), 'Instrumental');
        if (!instrumental) await fillOptional(SELECTORS.lyricsInput, prompt, 'Lyrics');

        const before = new Set(await listClipIds());
        signal?.throwIfAborted();
        await first(SELECTORS.createButton).click();

        const ids = await waitForNewClips(before, signal);
        return { jobId: ids.join(',') };
      } catch (err) {
        throw toProviderError(err, cookie);
      }
    },

    async checkStatus({ jobId }, { apiKey, signal } = {}) {
      const ids = parseJobId(jobId);
      const cookie = resolveCookie(apiKey);
      signal?.throwIfAborted();
      const cookies = cookiesFrom(cookie);

      try {
        await ensureCreatePage(cookies, signal);
        const rows = await session.page.evaluate(readClipRowsInPage, { ids, songLink: SELECTORS.songLink });
        const clips = rows.map((row) => ({ id: row.id, state: classifyClipRow(row) }));
        const missing = rows.filter((row) => !row.found).map((row) => row.id);
        if (missing.length) log(`listede görünmeyen clip: ${missing.join(', ')} (iş ${jobId}).`);
        return { ...summarizeClips(clips), raw: rows };
      } catch (err) {
        throw toProviderError(err, cookie, { jobId, retryable: true });
      }
    },

    /** Yalnızca oturumu hazırlar (scripts/suno-login.js): create formu görünene kadar; şarkı üretmez, cookie kullanmaz. */
    async login({ signal } = {}) {
      try {
        await ensureCreatePage([], signal);
      } catch (err) {
        throw toProviderError(err);
      }
    },

    /** Tarayıcıyı (kalıcı context) kapatır; cookie'ler profile yazılır. Sonraki çağrı yeniden açar. */
    async close() {
      const current = session;
      session = null;
      if (current) await current.context.close();
    },
  };
}

/** Playwright hatalarını SunoGenerateError'a sarar; cookie mesajdan silinir. */
function toProviderError(err, cookie, { jobId, retryable = false } = {}) {
  if (err instanceof SunoGenerateError || err?.name === 'AbortError') return err;
  return new SunoGenerateError(`Suno tarayıcı botu hatası: ${err?.message ?? err}`, {
    jobId, retryable, secrets: [cookie], details: err,
  });
}
