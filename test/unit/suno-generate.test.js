import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SunoGenerateError, sanitizeApiKey } from '../../prep/suno-generate-errors.js';
import { assertProvider, normalizeStatus, normalizeStatusResult } from '../../prep/suno-generate-provider.js';
import {
  MAX_BACKOFF_MS,
  checkStatus,
  computeBackoff,
  generateSong,
  getApiKey,
  resolveApiKey,
  waitForSong,
} from '../../prep/suno-generate.js';
import { createFakeProvider, createFakeSleep } from '../helpers/fake-suno-provider.js';

/** Testler asla gerçek .env'e düşmesin diye env her çağrıda açıkça verilir. */
const ENV = { SUNO_GENERATE_API_KEY: 'sk-testkey1234567890abcdef' };
const base = (provider) => ({ provider, env: ENV });

// --- key okuma ---------------------------------------------------------------

test('1. getApiKey SUNO_GENERATE_API_KEY okur', () => {
  assert.equal(getApiKey(ENV), ENV.SUNO_GENERATE_API_KEY);
  assert.equal(getApiKey({}), undefined);
});

test('2. key yoksa SunoGenerateError (401) fırlatır', () => {
  assert.throws(
    () => resolveApiKey({ env: {} }),
    (err) => err instanceof SunoGenerateError && err.status === 401 && /SUNO_GENERATE_API_KEY/.test(err.message),
  );
});

test('3. key sağlayıcıya context ile gider, request gövdesine/URL\'e konmaz', async () => {
  const provider = createFakeProvider({ jobId: 'job-42' });
  await generateSong('lofi rainy night', base(provider));

  const { request, context } = provider.calls.generate[0];
  assert.equal(context.apiKey, ENV.SUNO_GENERATE_API_KEY);
  assert.ok(!JSON.stringify(request).includes(ENV.SUNO_GENERATE_API_KEY));
});

// --- sanitize ----------------------------------------------------------------

test('4. sanitizeApiKey bilinen key biçimlerini maskeler', () => {
  assert.equal(sanitizeApiKey('key: AIzaSy' + 'A'.repeat(33)), 'key: ***REDACTED***');
  assert.equal(sanitizeApiKey('token sk-abcdefghijklmnop123'), 'token ***REDACTED***');
  assert.match(sanitizeApiKey('Authorization: Bearer abcdef1234567890'), /Bearer \*\*\*REDACTED\*\*\*/);
  assert.equal(sanitizeApiKey('gizli-degerim-uzun', ['gizli-degerim-uzun']), '***REDACTED***');
});

test('5. sanitizeApiKey kısa/boş değerlerde metni bozmaz', () => {
  assert.equal(sanitizeApiKey('sorun yok'), 'sorun yok');
  assert.equal(sanitizeApiKey('abc geldi', ['abc']), 'abc geldi');
  assert.equal(sanitizeApiKey(''), '');
});

test('6. SunoGenerateError mesajındaki key sızıntısını temizler', () => {
  const err = new SunoGenerateError(`istek reddedildi: ${ENV.SUNO_GENERATE_API_KEY}`, {
    secrets: [ENV.SUNO_GENERATE_API_KEY],
  });
  assert.ok(!err.message.includes(ENV.SUNO_GENERATE_API_KEY));
  assert.match(err.message, /\*\*\*REDACTED\*\*\*/);
});

test('7. sağlayıcı hatasındaki key de temizlenir', async () => {
  const provider = createFakeProvider({
    generateResult: new Error(`upstream 401 for ${ENV.SUNO_GENERATE_API_KEY}`),
  });
  await assert.rejects(
    generateSong('lofi', base(provider)),
    (err) => err instanceof SunoGenerateError && !err.message.includes(ENV.SUNO_GENERATE_API_KEY),
  );
});

// --- generateSong ------------------------------------------------------------

test('8. generateSong jobId döndürür ve prompt trim edilir', async () => {
  const provider = createFakeProvider({ jobId: 'job-42' });
  const jobId = await generateSong('  lofi rainy night  ', base(provider));

  assert.equal(jobId, 'job-42');
  assert.equal(provider.calls.generate[0].request.prompt, 'lofi rainy night');
});

test('9. generateSong opsiyonel alanları sağlayıcıya iletir', async () => {
  const provider = createFakeProvider();
  await generateSong('lofi', { ...base(provider), style: 'jazzy lofi', title: 'Rain', instrumental: true });

  const { request } = provider.calls.generate[0];
  assert.equal(request.style, 'jazzy lofi');
  assert.equal(request.title, 'Rain');
  assert.equal(request.instrumental, true);
});

test('10. boş prompt reddedilir', async () => {
  const provider = createFakeProvider();
  await assert.rejects(generateSong('   ', base(provider)), SunoGenerateError);
  assert.equal(provider.calls.generate.length, 0);
});

test('11. sağlayıcı jobId vermezse hata', async () => {
  const provider = createFakeProvider({ generateResult: { id: 'yanlis-alan' } });
  await assert.rejects(generateSong('lofi', base(provider)), (err) => /jobId/.test(err.message));
});

test('12. provider verilmezse ya da sözleşmeye uymazsa hata', async () => {
  await assert.rejects(generateSong('lofi', { env: ENV }), SunoGenerateError);
  assert.throws(() => assertProvider({ generateSong() {} }), /checkStatus/);
});

// --- checkStatus -------------------------------------------------------------

test('13. checkStatus pending/done/failed durumlarını normalize eder', async () => {
  const provider = createFakeProvider({ statuses: [{ status: 'queued' }] });
  assert.deepEqual(await checkStatus('job-1', base(provider)), { status: 'pending', audioUrl: null, audioUrls: [], error: null });

  const done = createFakeProvider({ statuses: [{ status: 'complete', audioUrl: 'https://cdn.test/a.mp3' }] });
  assert.deepEqual(await checkStatus('job-1', base(done)), {
    status: 'done',
    audioUrl: 'https://cdn.test/a.mp3',
    audioUrls: ['https://cdn.test/a.mp3'],
    error: null,
  });

  const failed = createFakeProvider({ statuses: [{ status: 'error', error: 'moderation' }] });
  assert.deepEqual(await checkStatus('job-1', base(failed)), { status: 'failed', audioUrl: null, audioUrls: [], error: 'moderation' });
});

test('14. audioUrl yoksa "done" pending sayılır', () => {
  assert.equal(normalizeStatusResult({ status: 'succeeded' }).status, 'pending');
  assert.equal(normalizeStatusResult({ status: 'succeeded', audioUrl: 'ftp://x/a.mp3' }).status, 'pending');
  assert.equal(normalizeStatusResult({ status: 'succeeded', audioUrl: 'https://x/a.mp3' }).status, 'done');
});

test('15. tanınmayan durum pending sayılır (iş boşuna failed olmasın)', () => {
  assert.equal(normalizeStatus('bilinmeyen-durum'), 'pending');
  assert.equal(normalizeStatus(undefined), 'pending');
  assert.equal(normalizeStatus('FAILED'), 'failed');
});

test('16. checkStatus tek atış: retry yapmaz, beklemez', async () => {
  const provider = createFakeProvider({ statuses: [{ status: 'pending' }, { status: 'done' }] });
  const result = await checkStatus('job-1', base(provider));

  assert.equal(result.status, 'pending');
  assert.equal(provider.calls.status.length, 1);
});

test('17. jobId olmadan checkStatus çağrılamaz', async () => {
  await assert.rejects(checkStatus('', base(createFakeProvider())), SunoGenerateError);
});

// --- backoff -----------------------------------------------------------------

test('18. computeBackoff üstel artar ve tavanda durur', () => {
  assert.equal(computeBackoff(1, { initialMs: 1000 }), 1000);
  assert.equal(computeBackoff(2, { initialMs: 1000 }), 2000);
  assert.equal(computeBackoff(3, { initialMs: 1000 }), 4000);
  assert.equal(computeBackoff(20, { initialMs: 1000 }), MAX_BACKOFF_MS);
});

test('19. sağlayıcı Retry-After verdiyse ona uyulur (tavana tabi)', () => {
  assert.equal(computeBackoff(1, { initialMs: 1000, retryAfterMs: 9000 }), 9000);
  assert.equal(computeBackoff(1, { initialMs: 1000, retryAfterMs: 999999 }), MAX_BACKOFF_MS);
  assert.equal(computeBackoff(2, { initialMs: 1000, retryAfterMs: 0 }), 2000);
});

// --- waitForSong -------------------------------------------------------------

test('20. waitForSong sabit aralık değil exponential backoff kullanır', async () => {
  const provider = createFakeProvider({
    statuses: [
      { status: 'pending' },
      { status: 'pending' },
      { status: 'pending' },
      { status: 'done', audioUrl: 'https://cdn.test/a.mp3' },
    ],
  });
  const { sleepFn, waits } = createFakeSleep();

  const result = await waitForSong('job-1', { ...base(provider), sleepFn, initialBackoffMs: 1000 });

  assert.deepEqual(result, { jobId: 'job-1', audioUrl: 'https://cdn.test/a.mp3', audioUrls: ['https://cdn.test/a.mp3'] });
  assert.deepEqual(waits, [1000, 2000, 4000]);
  assert.equal(provider.calls.status.length, 4);
});

test('21. ilk denemede done ise hiç beklenmez', async () => {
  const provider = createFakeProvider({ statuses: [{ status: 'done', audioUrl: 'https://cdn.test/a.mp3' }] });
  const { sleepFn, waits } = createFakeSleep();

  await waitForSong('job-1', { ...base(provider), sleepFn });
  assert.deepEqual(waits, []);
});

test('22. failed durumunda sağlayıcı mesajıyla hata fırlatır', async () => {
  const provider = createFakeProvider({ statuses: [{ status: 'failed', error: 'moderation reddi' }] });
  const { sleepFn } = createFakeSleep();

  await assert.rejects(
    waitForSong('job-9', { ...base(provider), sleepFn }),
    (err) => err instanceof SunoGenerateError && err.jobId === 'job-9' && /moderation reddi/.test(err.message),
  );
});

test('23. deneme hakkı bitince timedOut hatası', async () => {
  const provider = createFakeProvider({ statuses: [{ status: 'pending' }] });
  const { sleepFn, waits } = createFakeSleep();

  await assert.rejects(
    waitForSong('job-1', { ...base(provider), sleepFn, maxAttempts: 3 }),
    (err) => err instanceof SunoGenerateError && err.timedOut === true,
  );
  assert.equal(provider.calls.status.length, 3);
  assert.equal(waits.length, 2, 'son denemeden sonra boşuna beklenmez');
});

test('24. geçici (retryable) hata beklenip tekrar denenir', async () => {
  const provider = createFakeProvider({
    statuses: [
      new SunoGenerateError('503 geçici', { retryable: true, status: 503 }),
      { status: 'done', audioUrl: 'https://cdn.test/a.mp3' },
    ],
  });
  const { sleepFn, waits } = createFakeSleep();

  const result = await waitForSong('job-1', { ...base(provider), sleepFn, initialBackoffMs: 1000 });

  assert.equal(result.audioUrl, 'https://cdn.test/a.mp3');
  assert.deepEqual(waits, [1000]);
});

test('25. retryable hata sağlayıcının retryAfterMs süresini kullanır', async () => {
  const provider = createFakeProvider({
    statuses: [
      new SunoGenerateError('429', { retryable: true, retryAfterMs: 7000 }),
      { status: 'done', audioUrl: 'https://cdn.test/a.mp3' },
    ],
  });
  const { sleepFn, waits } = createFakeSleep();

  await waitForSong('job-1', { ...base(provider), sleepFn, initialBackoffMs: 1000 });
  assert.deepEqual(waits, [7000]);
});

test('26. kalıcı hata anında fırlatılır, retry edilmez', async () => {
  const provider = createFakeProvider({
    statuses: [new SunoGenerateError('403 yetkisiz', { status: 403 })],
  });
  const { sleepFn } = createFakeSleep();

  await assert.rejects(
    waitForSong('job-1', { ...base(provider), sleepFn }),
    (err) => err.status === 403,
  );
  assert.equal(provider.calls.status.length, 1);
});

test('27. retryable hata deneme hakkını tüketirse o hata fırlatılır', async () => {
  const provider = createFakeProvider({ statuses: [new SunoGenerateError('503', { retryable: true })] });
  const { sleepFn } = createFakeSleep();

  await assert.rejects(
    waitForSong('job-1', { ...base(provider), sleepFn, maxAttempts: 2 }),
    (err) => err.retryable === true && err.timedOut === false,
  );
});

test('28. onProgress her bekleme öncesi bilgilendirir', async () => {
  const provider = createFakeProvider({
    statuses: [{ status: 'pending' }, { status: 'done', audioUrl: 'https://cdn.test/a.mp3' }],
  });
  const { sleepFn } = createFakeSleep();
  const seen = [];

  await waitForSong('job-1', {
    ...base(provider),
    sleepFn,
    initialBackoffMs: 1000,
    onProgress: (info) => seen.push(info),
  });

  assert.deepEqual(seen, [{ attempt: 1, status: 'pending', waitMs: 1000 }]);
});

test('29. iptal edilmiş signal ile iş başlatılmaz', async () => {
  const provider = createFakeProvider();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    generateSong('lofi', { ...base(provider), signal: controller.signal }),
    (err) => err.name === 'AbortError',
  );
  assert.equal(provider.calls.generate.length, 0);
});

// --- varyantlar ve üretim parametreleri (11f) ----------------------------------

test('30. normalizeStatusResult tüm varyantları sırayla, tekrarsız toplar', () => {
  const result = normalizeStatusResult({
    status: 'done',
    audioUrl: 'https://cdn.test/a.mp3',
    audioUrls: ['https://cdn.test/a.mp3', 'https://cdn.test/b.mp3', 'ftp://x/c.mp3', null],
  });
  assert.equal(result.audioUrl, 'https://cdn.test/a.mp3');
  assert.deepEqual(result.audioUrls, ['https://cdn.test/a.mp3', 'https://cdn.test/b.mp3']);

  const onlyList = normalizeStatusResult({ status: 'done', audioUrls: ['https://cdn.test/b.mp3'] });
  assert.equal(onlyList.status, 'done');
  assert.equal(onlyList.audioUrl, 'https://cdn.test/b.mp3');
});

test('31. generateSong negativeTags/styleWeight/weirdness değerlerini sağlayıcıya iletir', async () => {
  const provider = createFakeProvider();
  await generateSong('lofi', {
    ...base(provider),
    style: 's',
    title: 't',
    instrumental: true,
    model: 'V5_5',
    negativeTags: 'vocals',
    styleWeight: 0.75,
    weirdness: 0.3,
  });
  assert.deepEqual(provider.calls.generate[0].request, {
    prompt: 'lofi',
    style: 's',
    title: 't',
    instrumental: true,
    model: 'V5_5',
    negativeTags: 'vocals',
    styleWeight: 0.75,
    weirdness: 0.3,
  });
});
