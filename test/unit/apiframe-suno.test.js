import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SunoGenerateError } from '../../prep/suno-generate-errors.js';
import { waitForSong } from '../../prep/suno-generate.js';
import { APIFRAME_BASE_URL, createApiframeSunoProvider } from '../../prep/providers/apiframe-suno.js';
import { createFakeSleep } from '../helpers/fake-suno-provider.js';

const KEY = 'afk_testkey1234567890abcdef';
const CTX = { apiKey: KEY };

/** Sırayla yanıt veren sahte fetch; istekleri kaydeder. Canlı ağ yok. */
function fakeFetch(responses) {
  const calls = [];
  let i = 0;
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const next = responses[Math.min(i++, responses.length - 1)];
    if (next instanceof Error) throw next;
    const { status = 200, body, headers = {} } = next;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(headers),
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  fn.calls = calls;
  return fn;
}

const COMPLETED = {
  id: 'job-1',
  status: 'COMPLETED',
  result: {
    tracks: [
      { id: 'a', audioUrl: 'https://cdn2.apiframe.ai/audio/x-0.mp3', title: 'T' },
      { id: 'b', audioUrl: 'https://cdn2.apiframe.ai/audio/x-1.mp3', title: 'T' },
    ],
  },
  error: null,
};

test('generateSong - doğru uç, X-API-Key başlığı ve sunoParams gövdesi', async () => {
  const fetchFn = fakeFetch([{ status: 202, body: { jobId: 'job-1', status: 'QUEUED' } }]);
  const provider = createApiframeSunoProvider({ fetchFn });

  const result = await provider.generateSong({
    prompt: '[Instrumental] Quiet',
    style: 'lofi',
    title: 'Quiet',
    instrumental: true,
    model: 'V5',
    negativeTags: 'vocals',
    styleWeight: 0.75,
    weirdness: 0.3,
  }, CTX);

  assert.deepEqual(result, { jobId: 'job-1' });
  const { url, init, body } = fetchFn.calls[0];
  assert.equal(url, `${APIFRAME_BASE_URL}/music/generate`);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['X-API-Key'], KEY);
  assert.equal(init.headers.Authorization, undefined);
  assert.ok(!url.includes(KEY));
  assert.deepEqual(body, {
    prompt: '[Instrumental] Quiet',
    model: 'suno',
    sunoParams: {
      custom_mode: true,
      instrumental: true,
      model_version: 'V5',
      title: 'Quiet',
      style: 'lofi',
      negative_tags: 'vocals',
      style_weight: 0.75,
      weirdness_constraint: 0.3,
    },
  });
});

test('generateSong - model verilmezse V5_5; geçersiz model istek atmadan reddedilir', async () => {
  const fetchFn = fakeFetch([{ status: 202, body: { jobId: 'job-2' } }]);
  const provider = createApiframeSunoProvider({ fetchFn });

  await provider.generateSong({ prompt: 'lofi' }, CTX);
  assert.equal(fetchFn.calls[0].body.sunoParams.model_version, 'V5_5');
  assert.equal(fetchFn.calls[0].body.sunoParams.custom_mode, false);
  assert.ok(!('negative_tags' in fetchFn.calls[0].body.sunoParams));

  await assert.rejects(provider.generateSong({ prompt: 'lofi', model: 'V9' }, CTX), /model_version/);
  assert.equal(fetchFn.calls.length, 1);
});

test('generateSong - job id alanı farklıysa bulunur ve loglanır', async () => {
  const logs = [];
  const provider = createApiframeSunoProvider({
    fetchFn: fakeFetch([{ status: 202, body: { task_id: 'job-3' } }]),
    log: (m) => logs.push(m),
  });
  assert.deepEqual(await provider.generateSong({ prompt: 'x' }, CTX), { jobId: 'job-3' });
  assert.match(logs[0], /task_id/);

  const empty = createApiframeSunoProvider({ fetchFn: fakeFetch([{ status: 202, body: { status: 'QUEUED' } }]), log: () => {} });
  await assert.rejects(empty.generateSong({ prompt: 'x' }, CTX), /job id bulunamadı/);
});

test('HTTP hataları: 401/402 kalıcı, 429/503 geçici (Retry-After ile); key mesaja sızmaz', async () => {
  const cases = [
    { status: 401, body: { error: `bad key ${KEY}` }, retryable: false, hint: /SUNO_GENERATE_API_KEY/ },
    { status: 402, body: { error: 'Insufficient credits' }, retryable: false, hint: /kredisi yetersiz/ },
    { status: 429, body: 'slow down', headers: { 'retry-after': '7' }, retryable: true, retryAfterMs: 7000 },
    { status: 503, body: { message: 'unavailable' }, retryable: true },
  ];
  for (const c of cases) {
    const provider = createApiframeSunoProvider({ fetchFn: fakeFetch([c]) });
    await assert.rejects(provider.generateSong({ prompt: 'x' }, CTX), (err) => {
      assert.ok(err instanceof SunoGenerateError);
      assert.equal(err.status, c.status);
      assert.equal(err.retryable, c.retryable);
      assert.ok(!err.message.includes(KEY), err.message);
      if (c.hint) assert.match(err.message, c.hint);
      if (c.retryAfterMs) assert.equal(err.retryAfterMs, c.retryAfterMs);
      return true;
    });
  }
});

test('ağ hatası geçicidir; JSON olmayan başarılı yanıt hatadır', async () => {
  const net = createApiframeSunoProvider({ fetchFn: fakeFetch([new Error('ECONNRESET')]) });
  await assert.rejects(net.checkStatus({ jobId: 'j' }, CTX), (err) => err.retryable === true && err.jobId === 'j');

  const html = createApiframeSunoProvider({ fetchFn: fakeFetch([{ status: 200, body: '<html>' }]) });
  await assert.rejects(html.checkStatus({ jobId: 'j' }, CTX), /geçersiz JSON/);
});

test('checkStatus - result.tracks[].audioUrl tüm varyantları sırayla döner', async () => {
  const fetchFn = fakeFetch([{ body: COMPLETED }]);
  const provider = createApiframeSunoProvider({ fetchFn, log: () => assert.fail('log beklenmiyordu') });

  const raw = await provider.checkStatus({ jobId: 'job/1' }, CTX);
  assert.equal(fetchFn.calls[0].url, `${APIFRAME_BASE_URL}/jobs/job%2F1`);
  assert.equal(fetchFn.calls[0].init.method, 'GET');
  assert.equal(raw.status, 'COMPLETED');
  assert.deepEqual(raw.audioUrls, ['https://cdn2.apiframe.ai/audio/x-0.mp3', 'https://cdn2.apiframe.ai/audio/x-1.mp3']);
  assert.equal(raw.audioUrl, 'https://cdn2.apiframe.ai/audio/x-0.mp3');
});

test('checkStatus - farklı alan adı loglanır; COMPLETED ama adres yoksa loglanır', async () => {
  const logs = [];
  const alt = createApiframeSunoProvider({
    fetchFn: fakeFetch([{ body: { status: 'COMPLETED', result: { tracks: [{ audio_url: 'https://c/a.mp3' }] } } }]),
    log: (m) => logs.push(m),
  });
  assert.deepEqual((await alt.checkStatus({ jobId: 'j' }, CTX)).audioUrls, ['https://c/a.mp3']);
  assert.match(logs[0], /audio_url/);

  const none = createApiframeSunoProvider({
    fetchFn: fakeFetch([{ body: { status: 'COMPLETED', result: { clips: [] } } }]),
    log: (m) => logs.push(m),
  });
  assert.deepEqual((await none.checkStatus({ jobId: 'j' }, CTX)).audioUrls, []);
  assert.match(logs[1], /ses adresi yok; alanlar: clips/);
});

test('waitForSong ile uçtan uca: QUEUED → PROCESSING → COMPLETED', async () => {
  const fetchFn = fakeFetch([
    { body: { status: 'QUEUED', result: null } },
    { body: { status: 'PROCESSING', progress: 50, result: null } },
    { body: COMPLETED },
  ]);
  const provider = createApiframeSunoProvider({ fetchFn });
  const { sleepFn } = createFakeSleep();

  const result = await waitForSong('job-1', { provider, env: { SUNO_GENERATE_API_KEY: KEY }, sleepFn });
  assert.equal(result.audioUrl, 'https://cdn2.apiframe.ai/audio/x-0.mp3');
  assert.equal(result.audioUrls.length, 2);
  assert.equal(fetchFn.calls.length, 3);
});

test('waitForSong - FAILED iş hata mesajıyla düşer', async () => {
  const provider = createApiframeSunoProvider({
    fetchFn: fakeFetch([{ body: { status: 'FAILED', result: null, error: 'content policy' } }]),
  });
  await assert.rejects(
    waitForSong('job-9', { provider, env: { SUNO_GENERATE_API_KEY: KEY }, sleepFn: createFakeSleep().sleepFn }),
    /başarısız \(job-9\): content policy/,
  );
});
