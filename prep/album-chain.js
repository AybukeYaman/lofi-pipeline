/**
 * Albüm üretim zinciri (11f-3) — orkestratör.
 *
 *   album-planner (Gemini: başlık + atmosfer)
 *     → album-arc (faz + enerji, deterministik)
 *     → album-prompt (DNA + varyant, Suno sınır doğrulaması)
 *     → suno-generate (provider arayüzü; somut sağlayıcıyı bilmez)
 *     → suno-ingest.downloadAudio → audio/
 *
 * Bir parça başarısız olursa diğerleri devam eder; sonda başarılı / başarısız /
 * atlanan özeti döner (ui/actions.js batchBuild deseni).
 */

import { mkdir } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

import { listFiles } from '../core/files.js';
import { writeTextFile } from '../core/workspace.js';
import { energyModifiers, phaseFor } from './album-arc.js';
import { AlbumPlanError } from './album-errors.js';
import { planTrackIdeas } from './album-planner.js';
import { assertSunoLimits, buildAlbumDna, buildNegativeTags, buildTrackStyle } from './album-prompt.js';
import { loadStyle } from './styles.js';
import { generateSong, waitForSong } from './suno-generate.js';
import { audioExtension, downloadAudio, sanitizeFilename } from './suno-ingest.js';

/**
 * Üretim parametreleri. styleWeight yüksek → albüm tutarlılığı;
 * weirdness düşük → sürpriz albümü bozmasın.
 */
export const GENERATION_PARAMS = Object.freeze({ styleWeight: 0.75, weirdness: 0.3, instrumental: true });
export const DEFAULT_MODEL_VERSION = 'V5_5';
export const MANIFEST_NAME = 'album-manifest.json';

export const RESULT = Object.freeze({ OK: 'ok', FAILED: 'failed', SKIPPED: 'skipped' });

/**
 * Konsept → üretime hazır parça listesi. Gemini yalnızca başlık/atmosfer verir;
 * yay ve stil dizesi burada deterministik kurulur.
 *
 * @param {{ concept: string, styleName: string, trackCount: number }} params
 * @param {object} [options] planTrackIdeas seçenekleri (fetchFn, apiKey, env, …) +
 * @param {string} [options.stylesDir]
 * @param {typeof planTrackIdeas} [options.planTrackIdeas] test/alternatif planlayıcı
 * @returns {Promise<{ albumTitle: string, tracks: Array<{ index: number, title: string, atmosphere: string, phase: string, styleString: string, negativeTags: string }> }>}
 * @throws {AlbumPlanError} stil okunamazsa, DNA kurulamazsa ya da bir parça Suno sınırını aşarsa
 */
export async function planAlbum({ concept, styleName, trackCount } = {}, options = {}) {
  if (typeof styleName !== 'string' || styleName.trim() === '') {
    throw new AlbumPlanError('Stil adı belirtilmeli.');
  }

  let style;
  try {
    ({ style } = await loadStyle(styleName, { dir: options.stylesDir }));
  } catch (cause) {
    throw new AlbumPlanError(`Stil okunamadı (${styleName}): ${cause.message}`);
  }

  // Gemini'ye gitmeden önce: stil albüm üretimine uygun değilse kota harcanmasın.
  const dna = buildAlbumDna(style);
  const negativeTags = buildNegativeTags(style);

  const planner = options.planTrackIdeas ?? planTrackIdeas;
  const ideas = await planner({ concept, trackCount, styleContext: dna }, options);

  const tracks = ideas.tracks.map((idea, i) => {
    const phase = phaseFor(i, ideas.tracks.length);
    const styleString = buildTrackStyle({ dna, atmosphere: idea.atmosphere, energyMods: energyModifiers(phase.energy) });
    assertSunoLimits({ style: styleString, negativeTags, title: idea.title });
    return {
      index: i + 1,
      title: idea.title,
      atmosphere: idea.atmosphere,
      phase: phase.name,
      styleString,
      negativeTags,
    };
  });

  return { albumTitle: ideas.albumTitle, tracks };
}

/** "03-Quiet-Moments" — uzantısız dosya adı (suno-ingest ile aynı kural). */
export function trackBaseName(track) {
  return `${String(track.index).padStart(2, '0')}-${sanitizeFilename(track.title)}`;
}

/**
 * Parçaları sırayla üretir, ilk varyantı indirir, diğer varyantları manifest'e yazar.
 *
 * @param {Array<{ index: number, title: string, phase?: string, styleString: string, negativeTags?: string }>} tracks
 * @param {object} options
 * @param {string} options.outputDir audio/ klasörü
 * @param {import('./suno-generate-provider.js').SunoGenerateProvider} options.provider
 * @param {string} [options.albumTitle]
 * @param {string} [options.modelVersion] varsayılan DEFAULT_MODEL_VERSION
 * @param {string|null} [options.manifestPath] varsayılan <outputDir>/../album-manifest.json; null → yazma
 * @param {typeof fetch} [options.fetchFn] indirme için
 * @param {(event: { track: object, stage: string, detail?: object }) => void} [options.onTrack]
 * @param {AbortSignal} [options.signal]
 *   + suno-generate seçenekleri (apiKey, env, repoRoot, sleepFn, maxAttempts, …)
 * @returns {Promise<{ results: object[], ok: object[], failed: object[], skipped: object[], manifestPath: string|null }>}
 */
export async function generateAlbum(tracks, options = {}) {
  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw new AlbumPlanError('Üretilecek parça listesi boş.');
  }
  const { outputDir, provider, fetchFn, onTrack, signal } = options;
  if (!outputDir) {
    throw new AlbumPlanError('Çıktı klasörü (outputDir) belirtilmeli.');
  }
  const modelVersion = options.modelVersion ?? DEFAULT_MODEL_VERSION;
  const manifestPath = options.manifestPath === undefined
    ? join(dirname(outputDir), MANIFEST_NAME)
    : options.manifestPath;

  await mkdir(outputDir, { recursive: true });
  const existing = new Set((await listFiles(outputDir)).map((path) => basename(path, extname(path))));

  const results = [];
  let cancelled = false;

  for (const track of tracks) {
    const base = { index: track.index, title: track.title, phase: track.phase ?? null };

    if (cancelled) {
      results.push({ ...base, result: RESULT.SKIPPED, reason: 'iptal edildi' });
      continue;
    }
    // Yeniden çalıştırmada kredi harcamasın: aynı adlı dosya varsa üretme.
    if (existing.has(trackBaseName(track))) {
      results.push({ ...base, result: RESULT.SKIPPED, reason: 'dosya zaten var' });
      onTrack?.({ track, stage: RESULT.SKIPPED });
      continue;
    }

    let jobId = null;
    try {
      const negativeTags = track.negativeTags ?? '';
      assertSunoLimits({ style: track.styleString, negativeTags, title: track.title });

      onTrack?.({ track, stage: 'generate' });
      jobId = await generateSong(`[Instrumental] ${track.title}`, {
        ...options,
        style: track.styleString,
        title: track.title,
        negativeTags,
        model: modelVersion,
        ...GENERATION_PARAMS,
      });

      onTrack?.({ track, stage: 'wait', detail: { jobId } });
      const { audioUrls } = await waitForSong(jobId, options);
      const [audioUrl, ...alternateUrls] = audioUrls;

      const file = join(outputDir, `${trackBaseName(track)}${audioExtension(audioUrl)}`);
      onTrack?.({ track, stage: 'download', detail: { jobId, file } });
      await downloadAudio({ url: audioUrl, localPath: file, label: `Parça ${track.index} (${track.title})` }, fetchFn);

      results.push({ ...base, result: RESULT.OK, jobId, file, audioUrl, alternateUrls });
      onTrack?.({ track, stage: RESULT.OK, detail: { jobId, file } });
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) {
        cancelled = true;
        results.push({ ...base, result: RESULT.SKIPPED, reason: 'iptal edildi', jobId });
      } else {
        results.push({ ...base, result: RESULT.FAILED, jobId, error: err?.message ?? String(err) });
        onTrack?.({ track, stage: RESULT.FAILED, detail: { error: err } });
      }
    }

    // Her parçadan sonra: süreç yarıda kesilse de o ana kadarki kayıt kalsın.
    if (manifestPath) await writeManifest(manifestPath, { albumTitle: options.albumTitle, modelVersion, tracks, results });
  }

  return {
    results,
    ok: results.filter((r) => r.result === RESULT.OK),
    failed: results.filter((r) => r.result === RESULT.FAILED),
    skipped: results.filter((r) => r.result === RESULT.SKIPPED),
    manifestPath: manifestPath ?? null,
  };
}

/**
 * Manifest içeriği — saf. İkinci varyantın URL'i burada: kullanıcı ilkini
 * beğenmezse elle değiştirir.
 */
export function buildManifest({ albumTitle, modelVersion, tracks, results }) {
  const byIndex = new Map(results.map((r) => [r.index, r]));
  return {
    albumTitle: albumTitle ?? null,
    modelVersion,
    params: { ...GENERATION_PARAMS },
    tracks: tracks.map((track) => {
      const r = byIndex.get(track.index);
      return {
        index: track.index,
        title: track.title,
        phase: track.phase ?? null,
        styleString: track.styleString,
        negativeTags: track.negativeTags ?? '',
        result: r?.result ?? 'pending',
        jobId: r?.jobId ?? null,
        file: r?.file ? basename(r.file) : null,
        audioUrl: r?.audioUrl ?? null,
        alternateUrls: r?.alternateUrls ?? [],
        ...(r?.error ? { error: r.error } : {}),
        ...(r?.reason ? { reason: r.reason } : {}),
      };
    }),
  };
}

async function writeManifest(path, data) {
  await writeTextFile(path, `${JSON.stringify(buildManifest(data), null, 2)}\n`);
}

/**
 * Özet metni (batchBuild ile aynı biçim).
 * @param {{ results: object[] }} summary
 * @returns {string}
 */
export function formatAlbumSummary({ results }) {
  const pad = (r) => String(r.index).padStart(2, '0');
  const line = (r) => {
    switch (r.result) {
      case RESULT.OK: return `  [başarılı]  ${pad(r)} ${r.title} — ${basename(r.file)}`;
      case RESULT.FAILED: return `  [başarısız] ${pad(r)} ${r.title} — ${r.error}`;
      default: return `  [atlandı]   ${pad(r)} ${r.title} — ${r.reason}`;
    }
  };
  const count = (kind) => results.filter((r) => r.result === kind).length;
  return [
    'Albüm üretim özeti:',
    ...results.map(line),
    `Toplam: ${count(RESULT.OK)} başarılı, ${count(RESULT.FAILED)} başarısız, ${count(RESULT.SKIPPED)} atlandı.`,
  ].join('\n');
}
