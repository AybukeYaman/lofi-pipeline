import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import {
  DEFAULT_MODEL_VERSION,
  GENERATION_PARAMS,
  MANIFEST_NAME,
  formatAlbumSummary,
  generateAlbum,
  planAlbum,
  trackBaseName,
} from '../../prep/album-chain.js';
import { AlbumPlanError, AlbumPromptError } from '../../prep/album-errors.js';
import { createFakeSleep } from '../helpers/fake-suno-provider.js';

/** Canlı API'ye çıkmasın: env her çağrıda açıkça verilir. */
const ENV = { SUNO_GENERATE_API_KEY: 'sk-testkey1234567890abcdef' };

const MUSIC = {
  genre: 'lofi hip hop',
  production: 'warm tape saturation',
  instruments: ['Rhodes piano', 'upright bass'],
  aesthetic: 'late night city',
  exclude: ['vocals', 'EDM'],
};

function styleJson(name, music) {
  return {
    name,
    styleBlock: {
      medium: 'm', lines: 'l', palette: [{ hex: '#000000', role: 'r' }],
      light: 'li', texture: 't', contrast: 'c', shading: 's',
    },
    suggestedAmbient: 'none',
    motionHints: ['rain falling'],
    ...(music ? { music } : {}),
  };
}

/** Parça sayısı kadar başlık/atmosfer üreten sahte planlayıcı. */
function fakePlanner(calls = []) {
  return async (params) => {
    calls.push(params);
    return {
      albumTitle: 'Night Album',
      tracks: Array.from({ length: params.trackCount }, (_, i) => ({
        index: i + 1,
        title: `Track Name ${i + 1}`,
        atmosphere: `moment ${i + 1}`,
      })),
    };
  };
}

/**
 * İş başına ayrı durum tutan sahte sağlayıcı.
 * failTitles: üretimi 'failed' dönecek başlıklar.
 */
function fakeProvider({ failTitles = [], throwOnTitle = null } = {}) {
  const calls = { generate: [], status: [] };
  const jobs = new Map();
  return {
    name: 'fake',
    calls,
    async generateSong(request, context) {
      calls.generate.push({ request, context });
      if (request.title === throwOnTitle) throw new Error('upstream 500');
      const jobId = `job-${calls.generate.length}`;
      jobs.set(jobId, request);
      return { jobId };
    },
    async checkStatus({ jobId }) {
      calls.status.push(jobId);
      const request = jobs.get(jobId);
      if (failTitles.includes(request.title)) return { status: 'failed', error: 'moderation' };
      return {
        status: 'complete',
        audioUrls: [`https://cdn.test/${jobId}-a.mp3`, `https://cdn.test/${jobId}-b.mp3`],
      };
    },
  };
}

function fakeFetch({ failUrls = [] } = {}) {
  const urls = [];
  const fn = async (url) => {
    urls.push(url);
    if (failUrls.includes(url)) return { ok: false, status: 500 };
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([0x49, 0x44, 0x33]).buffer };
  };
  fn.urls = urls;
  return fn;
}

let root;
let stylesDir;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'album-chain-'));
  stylesDir = join(root, 'styles');
  await mkdir(stylesDir);
  await writeFile(join(stylesDir, 'night-lofi.json'), JSON.stringify(styleJson('night-lofi', MUSIC)));
  await writeFile(join(stylesDir, 'no-music.json'), JSON.stringify(styleJson('no-music')));
  await writeFile(
    join(stylesDir, 'long-exclude.json'),
    JSON.stringify(styleJson('long-exclude', { ...MUSIC, exclude: Array.from({ length: 30 }, (_, i) => `unwanted tag ${i}`) })),
  );
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('planAlbum', () => {
  test('yay + DNA + negatif etiketler deterministik birleşir', async () => {
    const calls = [];
    const plan = await planAlbum(
      { concept: 'Night walk', styleName: 'night-lofi', trackCount: 5 },
      { stylesDir, planTrackIdeas: fakePlanner(calls) },
    );

    assert.equal(plan.albumTitle, 'Night Album');
    assert.deepEqual(plan.tracks.map((t) => t.phase), ['opening', 'descent', 'trough', 'ascent', 'resolution']);

    const dna = 'lofi hip hop, warm tape saturation, Rhodes piano, upright bass, late night city';
    assert.equal(calls[0].styleContext, dna);
    for (const track of plan.tracks) {
      assert.ok(track.styleString.startsWith(`[Instrumental] ${dna}, moment ${track.index}, `));
      assert.ok(track.styleString.endsWith('. No vocals, no lyrics. [No Vocals]'));
      assert.equal(track.negativeTags, 'vocals, EDM');
    }
    // Ortadaki parça en sade enerji kademesinde.
    assert.match(plan.tracks[2].styleString, /very slow tempo, spacious\./);
    assert.deepEqual(Object.keys(plan.tracks[0]).sort(), ['atmosphere', 'index', 'negativeTags', 'phase', 'styleString', 'title']);
  });

  test('stil uygun değilse Gemini hiç çağrılmaz', async () => {
    const calls = [];
    await assert.rejects(
      () => planAlbum({ concept: 'x', styleName: 'no-music', trackCount: 3 }, { stylesDir, planTrackIdeas: fakePlanner(calls) }),
      AlbumPromptError,
    );
    await assert.rejects(
      () => planAlbum({ concept: 'x', styleName: 'long-exclude', trackCount: 3 }, { stylesDir, planTrackIdeas: fakePlanner(calls) }),
      (err) => err.field === 'negativeTags',
    );
    await assert.rejects(
      () => planAlbum({ concept: 'x', styleName: 'olmayan', trackCount: 3 }, { stylesDir, planTrackIdeas: fakePlanner(calls) }),
      /Stil okunamadı/,
    );
    await assert.rejects(() => planAlbum({ concept: 'x', styleName: '' }), AlbumPlanError);
    assert.equal(calls.length, 0);
  });

  test('başlık 80 karakteri aşarsa plan reddedilir', async () => {
    const planner = async () => ({ albumTitle: 'x', tracks: [{ index: 1, title: 'x'.repeat(81), atmosphere: 'a' }] });
    await assert.rejects(
      () => planAlbum({ concept: 'x', styleName: 'night-lofi', trackCount: 1 }, { stylesDir, planTrackIdeas: planner }),
      (err) => err instanceof AlbumPromptError && err.field === 'title',
    );
  });
});

describe('generateAlbum', () => {
  const track = (index, title, extra = {}) => ({
    index,
    title,
    phase: 'opening',
    styleString: `[Instrumental] lofi, ${title}. No vocals, no lyrics. [No Vocals]`,
    negativeTags: 'vocals',
    ...extra,
  });

  async function freshDir(name) {
    const projectDir = join(root, name);
    return { projectDir, audioDir: join(projectDir, 'audio') };
  }

  test('sırayla üretir, ilk varyantı indirir, ikincisini manifest\'e yazar', async () => {
    const { projectDir, audioDir } = await freshDir('ok');
    const provider = fakeProvider();
    const fetchFn = fakeFetch();
    const { sleepFn } = createFakeSleep();

    const summary = await generateAlbum([track(1, 'Quiet Start'), track(3, 'Quiet Moments')], {
      outputDir: audioDir, provider, env: ENV, fetchFn, sleepFn, albumTitle: 'Night Album',
    });

    assert.equal(summary.ok.length, 2);
    assert.deepEqual((await readdir(audioDir)).sort(), ['01-Quiet-Start.mp3', '03-Quiet-Moments.mp3']);
    assert.deepEqual(fetchFn.urls, ['https://cdn.test/job-1-a.mp3', 'https://cdn.test/job-2-a.mp3']);

    const { request } = provider.calls.generate[1];
    assert.deepEqual(request, {
      prompt: '[Instrumental] Quiet Moments',
      style: track(3, 'Quiet Moments').styleString,
      title: 'Quiet Moments',
      instrumental: true,
      model: DEFAULT_MODEL_VERSION,
      negativeTags: 'vocals',
      styleWeight: 0.75,
      weirdness: 0.3,
    });

    const manifest = JSON.parse(await readFile(join(projectDir, MANIFEST_NAME), 'utf8'));
    assert.equal(manifest.albumTitle, 'Night Album');
    assert.equal(manifest.modelVersion, 'V5_5');
    assert.deepEqual(manifest.params, { ...GENERATION_PARAMS });
    assert.equal(manifest.tracks[1].file, '03-Quiet-Moments.mp3');
    assert.equal(manifest.tracks[1].audioUrl, 'https://cdn.test/job-2-a.mp3');
    assert.deepEqual(manifest.tracks[1].alternateUrls, ['https://cdn.test/job-2-b.mp3']);
    assert.equal(summary.manifestPath, join(projectDir, MANIFEST_NAME));
  });

  test('bir parça başarısız olunca diğerleri devam eder; özet üç durumu ayırır', async () => {
    const { audioDir } = await freshDir('partial');
    await mkdir(audioDir, { recursive: true });
    await writeFile(join(audioDir, '04-Already-Here.mp3'), 'x');

    // Fırlatan çağrı da sayaca girer: Fine One = job-3, Download Fails = job-4.
    const provider = fakeProvider({ failTitles: ['Rejected'], throwOnTitle: 'Broken' });
    const fetchFn = fakeFetch({ failUrls: ['https://cdn.test/job-4-a.mp3'] });

    const tracks = [
      track(1, 'Rejected'),
      track(2, 'Broken'),
      track(3, 'Fine One'),
      track(4, 'Already Here'),
      track(5, 'Download Fails'),
      track(6, 'Too Long', { styleString: 's'.repeat(1001) }),
    ];
    const summary = await generateAlbum(tracks, {
      outputDir: audioDir, provider, env: ENV, fetchFn, sleepFn: createFakeSleep().sleepFn, modelVersion: 'V5',
    });

    assert.deepEqual(summary.results.map((r) => r.result), ['failed', 'failed', 'ok', 'skipped', 'failed', 'failed']);
    assert.match(summary.failed[0].error, /moderation/);
    assert.match(summary.failed[1].error, /upstream 500/);
    assert.match(summary.failed[2].error, /HTTP 500/);
    assert.equal(summary.failed[3].jobId, null);
    assert.match(summary.failed[3].error, /style Suno sınırını aşıyor/);
    assert.equal(summary.skipped[0].reason, 'dosya zaten var');

    // Sınırı aşan ve mevcut dosyası olan parça için istek hiç gönderilmedi.
    assert.deepEqual(provider.calls.generate.map((c) => c.request.title), ['Rejected', 'Broken', 'Fine One', 'Download Fails']);
    assert.ok(provider.calls.generate.every((c) => c.request.model === 'V5'));

    const text = formatAlbumSummary(summary);
    assert.match(text, /\[başarılı\] {2}03 Fine One — 03-Fine-One\.mp3/);
    assert.match(text, /\[atlandı\] {3}04 Already Here — dosya zaten var/);
    assert.match(text, /Toplam: 1 başarılı, 4 başarısız, 1 atlandı\./);
  });

  test('iptal edilince kalan parçalar atlanır', async () => {
    const { audioDir } = await freshDir('abort');
    const controller = new AbortController();
    const provider = fakeProvider();
    const originalGenerate = provider.generateSong;
    provider.generateSong = async (request, context) => {
      const result = await originalGenerate(request, context);
      controller.abort();
      return result;
    };

    const summary = await generateAlbum([track(1, 'One'), track(2, 'Two')], {
      outputDir: audioDir, provider, env: ENV, fetchFn: fakeFetch(), signal: controller.signal, manifestPath: null,
    });

    assert.deepEqual(summary.results.map((r) => [r.result, r.reason]), [['skipped', 'iptal edildi'], ['skipped', 'iptal edildi']]);
    assert.equal(summary.results[0].jobId, 'job-1');
    assert.equal(provider.calls.generate.length, 1);
    assert.equal(summary.manifestPath, null);
  });

  test('girdi doğrulaması', async () => {
    await assert.rejects(() => generateAlbum([], { outputDir: root }), /boş/);
    await assert.rejects(() => generateAlbum([track(1, 'x')], {}), /outputDir/);
  });

  test('trackBaseName - suno-ingest ile aynı adlandırma', () => {
    assert.equal(trackBaseName({ index: 3, title: 'Quiet Moments' }), '03-Quiet-Moments');
  });
});
