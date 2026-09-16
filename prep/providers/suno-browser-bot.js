/**
 * Suno tarayıcı botu — SunoGenerateProvider sözleşmesinin Playwright ile somut hali.
 *
 * Akış (görünür Chromium, kullanıcının kendi oturumu):
 *   SUNO_COOKIE → context.addCookies → suno.com/create → Custom Mode
 *   → style / exclude styles / başlık / instrumental → Create
 *   → yeni /song/<uuid> bağlantıları DOM'dan yakalanır → jobId = "uuid,uuid"
 *   checkStatus: aynı sayfada her clip satırının metni okunur (süre görünür → done).
 *
 * hCaptcha: OTOMATİK ÇÖZÜLMEZ. Çerçeve görünürse kullanıcıya bildirilir ve
 * elle çözülene kadar beklenir (captchaTimeoutMs).
 *
 * SEÇİCİLER CANLI SİTEDE DOĞRULANMADI — suno.com arayüzü değiştikçe yalnızca
 * SELECTORS güncellenir. Bekleme/backoff prep/suno-generate.js'te, indirme
 * prep/suno-ingest.js downloadAudio'da (album-chain üzerinden) kalır.
 *
 * Cookie, suno-generate'e `apiKey` olarak verilir: böylece hata mesajlarından
 * birebir silinir (SunoGenerateError secrets). Asla loglanmaz.
 */

import process from 'node:process';

import { SunoGenerateError } from '../suno-generate-errors.js';
import { loadEnv } from '../suno-generate.js';

export const SUNO_ORIGIN = 'https://suno.com';
export const SUNO_CREATE_URL = `${SUNO_ORIGIN}/create`;
/** Suno'nun kendi clip ses adresi deseni. */
export const SUNO_AUDIO_URL = (clipId) => `https://cdn1.suno.ai/${clipId}.mp3`;

/** Görünür tarayıcı: captcha elle çözülebilsin. */
export const LAUNCH_OPTIONS = Object.freeze({ headless: false });

export const PAGE_TIMEOUT_MS = 45000;
/** Create'ten sonra yeni clip'lerin listede görünmesi için süre (captcha beklemesi hariç). */
export const CLIP_APPEAR_TIMEOUT_MS = 120000;
export const CAPTCHA_TIMEOUT_MS = 10 * 60 * 1000;
export const POLL_INTERVAL_MS = 2000;
/** Suno bir üretimde genelde iki varyant çıkarır. */
export const EXPECTED_VARIANTS = 2;

export const CAPTCHA_MESSAGE = 'captcha bekleniyor, elle çöz — tarayıcı penceresinde captcha\'yı çözünce bot kendiliğinden devam edecek.';

/** Tüm DOM bağımlılığı burada. Virgüllü seçicilerde ilk eşleşen kullanılır. */
export const SELECTORS = Object.freeze({
  customModeToggle: 'button:has-text("Custom")',
  styleInput: 'textarea[placeholder*="style" i], textarea[aria-label*="style" i]',
  lyricsInput: 'textarea[placeholder*="lyrics" i], textarea[aria-label*="lyrics" i]',
  titleInput: 'input[placeholder*="title" i], input[aria-label*="title" i]',
  moreOptions: 'button:has-text("More Options"), button:has-text("Advanced Options")',
  negativeTagsInput: 'input[placeholder*="exclude" i], textarea[placeholder*="exclude" i]',
  instrumentalToggle: '[role="switch"][aria-label*="instrumental" i], button[aria-label*="instrumental" i], button:has-text("Instrumental")',
  createButton: 'button[aria-label="Create song"], button:has-text("Create")',
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
 * @param {{ cookie?: string, env?: object, repoRoot?: string }} [options]
 * @returns {string}
 */
export function resolveSunoCookie({ cookie, env, repoRoot } = {}) {
  if (!cookie && !env) loadEnv(repoRoot || process.cwd());
  const value = (cookie || getSunoCookie(env || process.env) || '').trim();
  if (!value) {
    throw new SunoGenerateError(
      'SUNO_COOKIE bulunamadı. suno.com\'da oturum açıkken bir isteğin Cookie başlığını .env dosyasına SUNO_COOKIE= olarak ekleyin.',
      { status: 401 },
    );
  }
  return value;
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

/** Gerçek tarayıcı: yalnızca canlı kullanımda yüklenir (testler launchBrowser verir). */
async function launchChromium() {
  const { chromium } = await import('playwright');
  return chromium.launch(LAUNCH_OPTIONS);
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
 * @param {() => Promise<object>} [deps.launchBrowser] Playwright Browser döndürür
 * @param {string} [deps.cookie] verilmezse context.apiKey, o da yoksa SUNO_COOKIE
 * @param {(message: string) => void} [deps.notify] kullanıcıya görünen mesajlar (captcha)
 * @param {(message: string) => void} [deps.log] ayrıntı/sapma bildirimleri
 * @param {typeof setTimeout} [deps.sleepFn]
 * @param {() => number} [deps.now]
 * @param {number} [deps.pageTimeoutMs]
 * @param {number} [deps.clipTimeoutMs]
 * @param {number} [deps.captchaTimeoutMs]
 * @param {number} [deps.pollIntervalMs]
 * @returns {import('../suno-generate-provider.js').SunoGenerateProvider & { close: () => Promise<void> }}
 */
export function createSunoBrowserBot({
  launchBrowser = launchChromium,
  cookie: fixedCookie,
  notify = (message) => console.log(`[suno-bot] ${message}`),
  log = (message) => console.warn(`[suno-bot] ${message}`),
  sleepFn,
  now = Date.now,
  pageTimeoutMs = PAGE_TIMEOUT_MS,
  clipTimeoutMs = CLIP_APPEAR_TIMEOUT_MS,
  captchaTimeoutMs = CAPTCHA_TIMEOUT_MS,
  pollIntervalMs = POLL_INTERVAL_MS,
} = {}) {
  /** @type {{ browser: any, page: any } | null} */
  let session = null;

  const sleep = (ms) => new Promise((done) => (sleepFn ? sleepFn(done, ms) : setTimeout(done, ms)));
  const first = (selector) => session.page.locator(selector).first();

  async function isVisible(selector) {
    const locator = first(selector);
    return (await locator.count()) > 0 && locator.isVisible();
  }

  async function openSession(cookie) {
    if (session) return session;
    const cookies = parseCookieHeader(cookie);
    if (cookies.length === 0) {
      throw new SunoGenerateError('SUNO_COOKIE ayrıştırılamadı ("ad=değer; ad2=değer2" biçimi beklenir).', { secrets: [cookie] });
    }
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      await context.addCookies(cookies);
      const page = await context.newPage();
      session = { browser, page };
    } catch (err) {
      await browser.close().catch(() => {});
      throw err;
    }
    return session;
  }

  /** Create sayfasında değilse gider; oturum yoksa anlaşılır hata. */
  async function ensureCreatePage(cookie, signal) {
    await openSession(cookie);
    const { page } = session;
    if (!String(page.url()).startsWith(SUNO_CREATE_URL)) {
      await page.goto(SUNO_CREATE_URL, { waitUntil: 'domcontentloaded', timeout: pageTimeoutMs });
    }
    await waitWhileCaptcha(signal);
    if (SIGN_IN_PATH.test(String(page.url()))) {
      throw new SunoGenerateError('Suno oturumu açılamadı: SUNO_COOKIE geçersiz ya da süresi dolmuş. Tarayıcıdan yeni Cookie kopyalayın.', { status: 401, secrets: [cookie] });
    }
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

  /** aria-pressed/aria-checked/data-state ile açık mı; değilse tıklar. */
  async function setToggle(selector, wanted, label) {
    if (!(await isVisible(selector))) {
      log(`${label} düğmesi bulunamadı (seçici: ${selector}).`);
      return;
    }
    const locator = first(selector);
    let current = null;
    for (const attr of ['aria-pressed', 'aria-checked', 'data-state']) {
      const value = await locator.getAttribute(attr);
      if (value !== null && value !== undefined) {
        current = ACTIVE_VALUES.has(String(value).toLowerCase());
        break;
      }
    }
    if (current === null) log(`${label} durumu okunamadı; tıklanıyor.`);
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
      const cookie = resolveSunoCookie({ cookie: fixedCookie || apiKey });
      signal?.throwIfAborted();
      if (!style) throw new SunoGenerateError('Suno botu Custom Mode kullanır: style zorunlu.');

      try {
        await ensureCreatePage(cookie, signal);
        await setToggle(SELECTORS.customModeToggle, true, 'Custom Mode');
        await fillRequired(SELECTORS.styleInput, style, 'Style');

        if (negativeTags && !(await isVisible(SELECTORS.negativeTagsInput)) && (await isVisible(SELECTORS.moreOptions))) {
          await first(SELECTORS.moreOptions).click();
        }
        if (negativeTags) await fillRequired(SELECTORS.negativeTagsInput, negativeTags, 'Exclude styles (negative tags)');

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
      const cookie = resolveSunoCookie({ cookie: fixedCookie || apiKey });
      signal?.throwIfAborted();

      try {
        await ensureCreatePage(cookie, signal);
        const rows = await session.page.evaluate(readClipRowsInPage, { ids, songLink: SELECTORS.songLink });
        const clips = rows.map((row) => ({ id: row.id, state: classifyClipRow(row) }));
        const missing = rows.filter((row) => !row.found).map((row) => row.id);
        if (missing.length) log(`listede görünmeyen clip: ${missing.join(', ')} (iş ${jobId}).`);
        return { ...summarizeClips(clips), raw: rows };
      } catch (err) {
        throw toProviderError(err, cookie, { jobId, retryable: true });
      }
    },

    /** Tarayıcıyı kapatır; generateSong/checkStatus sonra yeniden açabilir. */
    async close() {
      const current = session;
      session = null;
      if (current) await current.browser.close();
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
