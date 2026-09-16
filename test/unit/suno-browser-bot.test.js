import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';

import { generateAlbum } from '../../prep/album-chain.js';
import { SunoGenerateError } from '../../prep/suno-generate-errors.js';
import { generateSong, waitForSong } from '../../prep/suno-generate.js';
import {
  CAPTCHA_MESSAGE,
  DEFAULT_PROFILE_DIR,
  LAUNCH_OPTIONS,
  LOGIN_MESSAGE,
  PROFILE_API_KEY,
  SELECTORS,
  SUNO_AUDIO_URL,
  SUNO_CREATE_URL,
  classifyClipRow,
  createSunoBrowserBot,
  extractClipIds,
  parseCookieHeader,
  resolveProfileDir,
  resolveSunoCookie,
  summarizeClips,
} from '../../prep/providers/suno-browser-bot.js';
import { createFakeBrowser, createFakeClock } from '../helpers/fake-playwright.js';

const COOKIE = '__client=secretclientvalue123456; __session=eyJhbGciOiJSUzI1NiJ9.abc=def';
const ID_OLD = '00000000-0000-4000-8000-000000000000';
const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const song = (id) => `/song/${id}`;
const PROFILE_DIR = 'C:/sahte/suno-profile';

/** Gerçek .env'deki SUNO_COOKIE testlere karışmasın (loadEnvFile mevcut değişkeni ezmez). */
let savedCookie;
beforeEach(() => { savedCookie = process.env.SUNO_COOKIE; process.env.SUNO_COOKIE = ''; });
afterEach(() => {
  if (savedCookie === undefined) delete process.env.SUNO_COOKIE;
  else process.env.SUNO_COOKIE = savedCookie;
});

/** Oturumlu create sayfasının tam hali (Gelişmiş mod): tüm alanlar görünür, toggle'lar kapalı. */
function createPage(overrides = {}) {
  return {
    [SELECTORS.formModeTab]: {},
    [SELECTORS.inactiveFormModeTab]: { attrs: { 'aria-selected': 'false' } },
    [SELECTORS.styleInput]: {},
    [SELECTORS.titleInput]: {},
    [SELECTORS.lyricsInput]: {},
    [SELECTORS.negativeTagsInput]: {},
    [SELECTORS.instrumentalToggle]: { attrs: { 'data-selected': 'false' } },
    [SELECTORS.createButton]: {},
    ...overrides,
  };
}

function makeBot(fake, clock = createFakeClock(), extra = {}) {
  const notices = [];
  const logs = [];
  const bot = createSunoBrowserBot({
    launchContext: fake.launchContext,
    profileDir: PROFILE_DIR,
    sleepFn: clock.sleepFn,
    now: clock.now,
    notify: (m) => notices.push(m),
    log: (m) => logs.push(m),
    ...extra,
  });
  return { bot, notices, logs, clock };
}

const REQUEST = { prompt: '[Instrumental] Rain', style: 'lofi, rhodes', title: 'Rain', instrumental: true, negativeTags: 'vocals' };
const CTX = { apiKey: COOKIE };

describe('saf yardımcılar', () => {
  test('parseCookieHeader - "Cookie:" öneki, değerde "=", boş parçalar', () => {
    const cookies = parseCookieHeader(`Cookie: ${COOKIE}; ; bozuk`);
    assert.deepEqual(cookies.map((c) => [c.name, c.value]), [
      ['__client', 'secretclientvalue123456'],
      ['__session', 'eyJhbGciOiJSUzI1NiJ9.abc=def'],
    ]);
    assert.ok(cookies.every((c) => c.domain === '.suno.com' && c.path === '/' && c.secure));
    assert.deepEqual(parseCookieHeader(''), []);
    assert.deepEqual(parseCookieHeader(undefined), []);
  });

  test('extractClipIds - sıra korunur, tekrar ve yabancı bağlantı atılır', () => {
    const ids = extractClipIds([song(ID_B), `https://suno.com${song(ID_A.toUpperCase())}?x=1`, song(ID_B), '/song/kisa', null]);
    assert.deepEqual(ids, [ID_B, ID_A]);
  });

  test('classifyClipRow - süre → done, hata metni → failed, diğer → pending', () => {
    assert.equal(classifyClipRow({ found: true, text: 'Rain\nlofi\n2:47' }), 'done');
    assert.equal(classifyClipRow({ found: true, text: 'Rain\nGeneration failed' }), 'failed');
    assert.equal(classifyClipRow({ found: true, text: 'Rain\nlofi' }), 'pending');
    assert.equal(classifyClipRow({ found: false }), 'pending');
  });

  test('summarizeClips - bekleyen varsa pending, hepsi hatalıysa failed', () => {
    assert.deepEqual(summarizeClips([{ id: ID_A, state: 'done' }, { id: ID_B, state: 'pending' }]), { status: 'pending', audioUrls: [] });
    assert.deepEqual(summarizeClips([{ id: ID_A, state: 'done' }, { id: ID_B, state: 'failed' }]), { status: 'done', audioUrls: [SUNO_AUDIO_URL(ID_A)] });
    assert.equal(summarizeClips([{ id: ID_A, state: 'failed' }]).status, 'failed');
    assert.equal(summarizeClips([]).status, 'pending');
  });

  test('resolveSunoCookie - env yoksa anlaşılır hata, varsa değer', () => {
    assert.throws(() => resolveSunoCookie({ env: {} }), (err) => err instanceof SunoGenerateError && /SUNO_COOKIE/.test(err.message) && err.status === 401);
    assert.equal(resolveSunoCookie({ env: { SUNO_COOKIE: '  a=1  ' } }), 'a=1');
    assert.equal(resolveSunoCookie({ cookie: 'b=2', env: { SUNO_COOKIE: 'a=1' } }), 'b=2');
  });

  test('resolveSunoCookie - required=false iken cookie yoksa undefined', () => {
    assert.equal(resolveSunoCookie({ env: {}, required: false }), undefined);
    assert.equal(resolveSunoCookie({ env: { SUNO_COOKIE: 'a=1' }, required: false }), 'a=1');
  });

  test('resolveProfileDir - varsayılan .auth/suno-profile, SUNO_PROFILE_DIR ile değişir', () => {
    const root = resolve('C:/repo');
    assert.equal(resolveProfileDir({ env: {}, repoRoot: root }), resolve(root, DEFAULT_PROFILE_DIR));
    assert.equal(resolveProfileDir({ env: { SUNO_PROFILE_DIR: ' profiller/suno ' }, repoRoot: root }), resolve(root, 'profiller/suno'));
    assert.equal(resolveProfileDir({ env: { SUNO_PROFILE_DIR: 'D:/suno' }, repoRoot: root }), resolve('D:/suno'));
  });

  test('tarayıcı görünür (headed) açılır', () => {
    assert.equal(LAUNCH_OPTIONS.headless, false);
  });
});

describe('generateSong', () => {
  test('tam akış: kalıcı profil, create sayfası, alanlar, Create, iki yeni clip', async () => {
    const fake = createFakeBrowser({
      elements: createPage(),
      hrefs: [[song(ID_OLD)], [song(ID_OLD)], [song(ID_A), song(ID_B), song(ID_OLD)]],
    });
    const { bot } = makeBot(fake);

    const result = await bot.generateSong(REQUEST, CTX);

    assert.deepEqual(result, { jobId: `${ID_A},${ID_B}` });
    assert.deepEqual(fake.state.profileDirs, [PROFILE_DIR]);
    assert.deepEqual(fake.state.cookies, [], 'profil oturumu açıkken yedek cookie eklenmez');
    assert.deepEqual(fake.actions.map((a) => [a.type, a.selector ?? a.url, a.value]), [
      ['goto', SUNO_CREATE_URL, undefined],
      ['fill', SELECTORS.styleInput, 'lofi, rhodes'],
      ['fill', SELECTORS.negativeTagsInput, 'vocals'],
      ['fill', SELECTORS.titleInput, 'Rain'],
      ['click', SELECTORS.instrumentalToggle, undefined],
      ['click', SELECTORS.createButton, undefined],
    ]);
  });

  test('Basit moddaysa (style yok) seçili olmayan sekmeye geçilir; aria-selected okunur', async () => {
    let advanced = false;
    const fake = createFakeBrowser({
      elements: createPage({
        [SELECTORS.inactiveFormModeTab]: { attrs: { 'aria-selected': 'false' }, onClick: () => { advanced = true; } },
        [SELECTORS.styleInput]: { visible: () => advanced },
      }),
      hrefs: [[], [song(ID_A), song(ID_B)]],
    });
    const { bot } = makeBot(fake);

    await bot.generateSong(REQUEST, CTX);

    const order = fake.actions.map((a) => `${a.type}:${a.selector ?? a.url}`);
    assert.equal(order[1], `click:${SELECTORS.inactiveFormModeTab}`);
    assert.equal(order[2], `fill:${SELECTORS.styleInput}`);
  });

  test('zaten açık toggle tıklanmaz; instrumental değilse lyrics doldurulur', async () => {
    const fake = createFakeBrowser({
      elements: createPage({
        [SELECTORS.instrumentalToggle]: { attrs: { 'data-selected': 'true' } },
        [SELECTORS.inactiveFormModeTab]: { attrs: { 'aria-selected': 'true' } },
      }),
      hrefs: [[], [song(ID_A), song(ID_B)]],
    });
    const { bot } = makeBot(fake);

    await bot.generateSong({ prompt: 'la la', style: 'pop', instrumental: false }, CTX);

    const clicks = fake.actions.filter((a) => a.type === 'click').map((a) => a.selector);
    assert.deepEqual(clicks, [SELECTORS.instrumentalToggle, SELECTORS.createButton], 'instrumental açık → kapatılır, mod sekmesine dokunulmaz');
    assert.ok(fake.actions.some((a) => a.selector === SELECTORS.lyricsInput && a.value === 'la la'));
  });

  test('toggle durumu okunamıyorsa tıkla(ma)z, üretimi güvenli şekilde durdurup hata fırlatır', async () => {
    const fake = createFakeBrowser({
      elements: createPage({
        [SELECTORS.instrumentalToggle]: { attrs: {} },
      }),
      hrefs: [[], [song(ID_A), song(ID_B)]],
    });
    const { bot } = makeBot(fake);

    await assert.rejects(bot.generateSong(REQUEST, CTX), (err) => {
      assert.ok(err instanceof SunoGenerateError);
      assert.match(err.message, /durumunu doğrulayamadım; güvenli şekilde duruyorum/);
      return true;
    });

    const clicks = fake.actions.filter((a) => a.type === 'click').map((a) => a.selector);
    assert.ok(!clicks.includes(SELECTORS.instrumentalToggle), 'okunamayan toggle kesinlikle tıklanmamalı');
  });

  test('exclude alanı gizliyse önce More Options açılır', async () => {
    let expanded = false;
    const fake = createFakeBrowser({
      elements: createPage({
        [SELECTORS.moreOptions]: { onClick: () => { expanded = true; } },
        [SELECTORS.negativeTagsInput]: { visible: () => expanded },
      }),
      hrefs: [[], [song(ID_A), song(ID_B)]],
    });
    const { bot } = makeBot(fake);

    await bot.generateSong(REQUEST, CTX);

    const order = fake.actions.map((a) => a.selector);
    assert.ok(order.indexOf(SELECTORS.moreOptions) < order.indexOf(SELECTORS.negativeTagsInput));
  });

  test('negativeTags verildiğinde Exclude Styles alanı yoksa hata vermez, atlar ve loglar', async () => {
    const pageObj = createPage();
    delete pageObj[SELECTORS.negativeTagsInput];
    delete pageObj[SELECTORS.moreOptions];
    const fake = createFakeBrowser({
      elements: pageObj,
      hrefs: [[], [song(ID_A), song(ID_B)]],
    });
    const { bot, logs } = makeBot(fake);

    const result = await bot.generateSong(REQUEST, CTX);
    assert.deepEqual(result, { jobId: `${ID_A},${ID_B}` });
    assert.ok(logs.some((l) => l.includes("Exclude Styles mevcut UI'da yok")));
  });

  test('captcha: kullanıcı bir kez uyarılır, çözülene kadar beklenir, sonra devam', async () => {
    const clock = createFakeClock();
    const fake = createFakeBrowser({
      elements: createPage({
        [SELECTORS.captchaFrame]: { visible: () => clock.now() < 4000 },
      }),
      hrefs: [[], [song(ID_A), song(ID_B)]],
    });
    const { bot, notices } = makeBot(fake, clock);

    const { jobId } = await bot.generateSong(REQUEST, CTX);

    assert.equal(jobId, `${ID_A},${ID_B}`);
    assert.equal(notices.filter((m) => m === CAPTCHA_MESSAGE).length, 1);
    assert.ok(clock.waits.length >= 2, 'captcha süresince beklenmeli');
  });

  test('captcha süresinde çözülmezse hata', async () => {
    const fake = createFakeBrowser({ elements: createPage({ [SELECTORS.captchaFrame]: {} }) });
    const { bot } = makeBot(fake, createFakeClock(), { captchaTimeoutMs: 10000 });

    await assert.rejects(bot.generateSong(REQUEST, CTX), (err) => err instanceof SunoGenerateError && /Captcha/.test(err.message));
    assert.equal(fake.actions.filter((a) => a.type === 'click').length, 0, 'captcha çözülmeden hiçbir şeye tıklanmaz');
  });

  test('Create sonrası captcha beklemesi clip süresinden düşülmez', async () => {
    let created = false;
    let captchaChecks = 0;
    const fake = createFakeBrowser({
      elements: createPage({
        [SELECTORS.createButton]: { onClick: () => { created = true; } },
        [SELECTORS.captchaFrame]: { visible: () => created && ++captchaChecks <= 20 },
      }),
      // Captcha bittikten sonraki ilk bakışta liste henüz boş: süre uzatılmasaydı burada biterdi.
      hrefs: [[], [], [song(ID_A), song(ID_B)]],
    });
    const { bot } = makeBot(fake, createFakeClock(), { clipTimeoutMs: 5000, pollIntervalMs: 2000 });

    const { jobId } = await bot.generateSong(REQUEST, CTX);
    assert.equal(jobId, `${ID_A},${ID_B}`);
  });

  test('profilde oturum yoksa cookie yedeği eklenir, sayfa yenilenir, akış sürer', async () => {
    const hasCookie = () => fake.state.cookies.length > 0;
    const fake = createFakeBrowser({
      elements: createPage({
        [SELECTORS.formModeTab]: { visible: hasCookie },
        [SELECTORS.loginButton]: { visible: () => !hasCookie() },
      }),
      hrefs: [[], [song(ID_A), song(ID_B)]],
    });
    const { bot, logs, notices } = makeBot(fake);

    assert.deepEqual(await bot.generateSong(REQUEST, CTX), { jobId: `${ID_A},${ID_B}` });
    assert.deepEqual(fake.state.cookies.map((c) => c.name), ['__client', '__session']);
    assert.deepEqual(fake.actions.slice(0, 3).map((a) => a.type), ['goto', 'addCookies', 'goto']);
    assert.ok(logs.some((m) => /yedeği/.test(m)));
    assert.ok(!notices.includes(LOGIN_MESSAGE), 'yedek yetince elle giriş istenmez');
  });

  test('oturum yoksa elle giriş beklenir; giriş sonrası ana sayfadaysa create sayfasına dönülür', async () => {
    const clock = createFakeClock();
    const loggedIn = () => clock.now() >= 4000;
    const fake = createFakeBrowser({
      elements: createPage({
        [SELECTORS.formModeTab]: { visible: () => loggedIn() && fake.state.url === SUNO_CREATE_URL },
        [SELECTORS.loginButton]: { visible: () => !loggedIn() },
      }),
      // Oturumsuz Suno /create'ten ana sayfaya yönlendirir.
      landingUrl: () => (loggedIn() ? SUNO_CREATE_URL : 'https://suno.com/'),
      hrefs: [[], [song(ID_A), song(ID_B)]],
    });
    const { bot, notices } = makeBot(fake, clock);

    assert.deepEqual(await bot.generateSong(REQUEST, { apiKey: PROFILE_API_KEY }), { jobId: `${ID_A},${ID_B}` });
    assert.equal(notices.filter((m) => m === LOGIN_MESSAGE).length, 1);
    assert.equal(fake.actions.filter((a) => a.type === 'goto').length, 2);
    assert.deepEqual(fake.state.cookies, [], 'yer tutucu apiKey cookie sayılmaz');
  });

  test('giriş süresinde yapılmazsa 401 ve suno-login ipucu; cookie mesajda yok', async () => {
    const fake = createFakeBrowser({
      elements: createPage({ [SELECTORS.formModeTab]: { visible: false }, [SELECTORS.loginButton]: {} }),
      landingUrl: 'https://suno.com/sign-in?redirect=create',
    });
    const { bot } = makeBot(fake, createFakeClock(), { loginTimeoutMs: 10000 });

    await assert.rejects(bot.generateSong(REQUEST, CTX), (err) => {
      assert.equal(err.status, 401);
      assert.match(err.message, /suno-login/);
      assert.ok(!err.message.includes('secretclientvalue123456'));
      return true;
    });
    assert.equal(fake.actions.filter((a) => a.type === 'click').length, 0);
    assert.equal(fake.actions.filter((a) => a.type === 'goto').length, 2, 'giriş sayfasındayken yeniden yönlendirilmez');
  });

  test('ne form ne giriş düğmesi gelirse seçici ipucu veren hata', async () => {
    const elements = createPage();
    delete elements[SELECTORS.formModeTab];
    const fake = createFakeBrowser({ elements });
    const { bot } = makeBot(fake);

    await assert.rejects(bot.generateSong(REQUEST, CTX), /create formu .* yüklenmedi/);
  });

  test('Playwright hatası sarılır; cookie değeri sızmaz', async () => {
    const fake = createFakeBrowser({ gotoError: new Error(`net::ERR_FAILED cookie=${COOKIE}`) });
    const { bot } = makeBot(fake);

    await assert.rejects(bot.generateSong(REQUEST, CTX), (err) => {
      assert.ok(err instanceof SunoGenerateError);
      assert.ok(!err.message.includes('secretclientvalue123456'));
      assert.ok(!err.message.includes(COOKIE));
      return true;
    });
  });

  test('style alanı bulunamazsa seçici ipucu veren hata', async () => {
    const elements = createPage();
    delete elements[SELECTORS.styleInput];
    const fake = createFakeBrowser({ elements });
    const { bot } = makeBot(fake);

    await assert.rejects(bot.generateSong(REQUEST, CTX), /Style alanı bulunamadı/);
  });

  test('yeni clip hiç görünmezse süre sonunda hata; tek clip görünürse onunla devam', async () => {
    const none = createFakeBrowser({ elements: createPage(), hrefs: [[song(ID_OLD)]] });
    await assert.rejects(makeBot(none, createFakeClock(), { clipTimeoutMs: 6000 }).bot.generateSong(REQUEST, CTX), /yeni şarkı görünmedi/);

    const one = createFakeBrowser({ elements: createPage(), hrefs: [[], [song(ID_A)]] });
    const { bot, logs } = makeBot(one, createFakeClock(), { clipTimeoutMs: 6000 });
    assert.deepEqual(await bot.generateSong(REQUEST, CTX), { jobId: ID_A });
    assert.ok(logs.some((m) => /1 yeni clip/.test(m)));
  });

  test('style zorunlu; cookie ayrıştırılamazsa tarayıcı açılmaz', async () => {
    const fake = createFakeBrowser({ elements: createPage() });
    const { bot } = makeBot(fake);
    await assert.rejects(bot.generateSong({ prompt: 'x' }, CTX), /style zorunlu/);
    await assert.rejects(bot.generateSong(REQUEST, { apiKey: 'cookie-degil' }), /ayrıştırılamadı/);
    assert.equal(fake.launches(), 0);
  });

  test('iptal edilmiş signal ile hiçbir şey yapılmaz', async () => {
    const fake = createFakeBrowser({ elements: createPage() });
    const { bot } = makeBot(fake);
    await assert.rejects(bot.generateSong(REQUEST, { ...CTX, signal: AbortSignal.abort() }), { name: 'AbortError' });
    assert.equal(fake.launches(), 0);
  });
});

describe('checkStatus / waitForSong / close', () => {
  test('satır metinlerinden durum; oturum yeniden kullanılır', async () => {
    const fake = createFakeBrowser({
      elements: createPage(),
      hrefs: [[], [song(ID_A), song(ID_B)]],
      rows: [
        [{ id: ID_A, found: true, text: 'Rain' }, { id: ID_B, found: false }],
        [{ id: ID_A, found: true, text: 'Rain 2:31' }, { id: ID_B, found: true, text: 'Rain 2:40' }],
      ],
    });
    const { bot, logs } = makeBot(fake);
    const { jobId } = await bot.generateSong(REQUEST, CTX);

    const first = await bot.checkStatus({ jobId }, CTX);
    assert.equal(first.status, 'pending');
    assert.ok(logs.some((m) => m.includes(ID_B)));

    const second = await bot.checkStatus({ jobId }, CTX);
    assert.equal(second.status, 'done');
    assert.deepEqual(second.audioUrls, [SUNO_AUDIO_URL(ID_A), SUNO_AUDIO_URL(ID_B)]);
    assert.deepEqual(fake.state.evaluateArgs[0].ids, [ID_A, ID_B]);
    assert.equal(fake.launches(), 1);
    assert.equal(fake.actions.filter((a) => a.type === 'goto').length, 1);
  });

  test('geçersiz jobId reddedilir', async () => {
    const { bot } = makeBot(createFakeBrowser());
    await assert.rejects(bot.checkStatus({ jobId: 'job-1' }, CTX), /Geçersiz bot jobId/);
  });

  test('suno-generate waitForSong ile mevcut backoff deseni; hepsi hatalıysa failed', async () => {
    const fake = createFakeBrowser({
      elements: createPage(),
      rows: [
        [{ id: ID_A, found: true, text: '' }],
        [{ id: ID_A, found: true, text: '' }],
        [{ id: ID_A, found: true, text: '3:05' }],
      ],
    });
    const { bot, clock } = makeBot(fake);
    const result = await waitForSong(ID_A, { provider: bot, apiKey: COOKIE, env: {}, sleepFn: clock.sleepFn });
    assert.deepEqual(result, { jobId: ID_A, audioUrl: SUNO_AUDIO_URL(ID_A), audioUrls: [SUNO_AUDIO_URL(ID_A)] });
    assert.deepEqual(clock.waits, [2000, 4000]);

    const failing = createFakeBrowser({ elements: createPage(), rows: [[{ id: ID_A, found: true, text: 'Generation failed' }]] });
    const { bot: failBot, clock: c2 } = makeBot(failing);
    await assert.rejects(waitForSong(ID_A, { provider: failBot, apiKey: COOKIE, env: {}, sleepFn: c2.sleepFn }), /başarısız/);
  });

  test('suno-generate generateSong üzerinden: cookie apiKey olarak geçer', async () => {
    const fake = createFakeBrowser({ elements: createPage(), hrefs: [[], [song(ID_A), song(ID_B)]] });
    const { bot } = makeBot(fake);
    const jobId = await generateSong('[Instrumental] Rain', { provider: bot, apiKey: COOKIE, env: {}, style: 'lofi', instrumental: true });
    assert.equal(jobId, `${ID_A},${ID_B}`);
  });

  test('login: yalnızca formu doğrular; cookie eklemez, tıklamaz', async () => {
    process.env.SUNO_COOKIE = COOKIE;
    const fake = createFakeBrowser({ elements: createPage() });
    const { bot } = makeBot(fake);

    await bot.login();
    assert.deepEqual(fake.actions.map((a) => a.type), ['goto']);
    assert.deepEqual(fake.state.cookies, []);
    await bot.close();
    assert.equal(fake.state.closed, true);
  });

  test('close tarayıcıyı kapatır; sonraki çağrı yeniden açar', async () => {
    const fake = createFakeBrowser({ elements: createPage(), rows: [[{ id: ID_A, found: true, text: '' }]] });
    const { bot } = makeBot(fake);
    await bot.close();
    assert.equal(fake.state.closed, false, 'açık oturum yokken kapatacak bir şey yok');

    await bot.checkStatus({ jobId: ID_A }, CTX);
    await bot.close();
    assert.equal(fake.state.closed, true);
    await bot.checkStatus({ jobId: ID_A }, CTX);
    assert.equal(fake.launches(), 2);
  });
});

describe('albüm zinciri + downloadAudio', () => {
  let dir;
  before(async () => { dir = await mkdtemp(join(tmpdir(), 'suno-bot-')); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  test('bot ile üretilen ilk varyant suno-ingest downloadAudio ile indirilir', async () => {
    const fake = createFakeBrowser({
      elements: createPage(),
      hrefs: [[], [song(ID_A), song(ID_B)]],
      rows: [[{ id: ID_A, found: true, text: '2:00' }, { id: ID_B, found: true, text: '2:10' }]],
    });
    const { bot, clock } = makeBot(fake);
    const fetched = [];
    const fetchFn = async (url) => {
      fetched.push(url);
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('MP3').buffer };
    };

    const summary = await generateAlbum(
      [{ index: 1, title: 'Rain', styleString: 'lofi', negativeTags: 'vocals' }],
      { outputDir: join(dir, 'audio'), provider: bot, apiKey: COOKIE, env: {}, fetchFn, sleepFn: clock.sleepFn, manifestPath: null },
    );

    assert.equal(summary.ok.length, 1, JSON.stringify(summary.failed));
    assert.deepEqual(fetched, [SUNO_AUDIO_URL(ID_A)]);
    assert.deepEqual(summary.ok[0].alternateUrls, [SUNO_AUDIO_URL(ID_B)]);
    assert.equal(await readFile(summary.ok[0].file, 'utf8'), 'MP3');
  });
});
