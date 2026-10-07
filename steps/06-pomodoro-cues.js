/**
 * Aşama 6 — Pomodoro işaret sesleri (countdown beep + oturum başlangıç efekti).
 *
 * Oturum geçişlerini duyulur kılar. Zamanlar `core/pomodoro-plan.js`
 * `buildCueEvents`'ten gelir; bu katman yalnızca "o anlara sesi nasıl koyarım"
 * sorusunu yanıtlar.
 *
 * İki kural spec'ten geliyor ve tasarımı belirliyor:
 *
 *   1. Sesler track'lerin İÇİNE gömülmez. Müzik dosyaları da, `mix.wav` da
 *      değişmez; işaretler timeline seviyesinde, nihai ses karışımının üzerine
 *      bindirilir. Pomodoro kapatılırsa geriye hiçbir iz kalmaz.
 *   2. Müziği bastırmaz ama rahat duyulur. Seviye müziğin ÖLÇÜLEN tepe
 *      değerine göre belirlenir (`cue.volumeDb`, config'den değişir).
 *
 * Neden tepe (peak) ölçümü, 03-ambient-mix'teki gibi LUFS değil: beep 0.12
 * saniye sürüyor. Entegre gürültü ölçümü bu kadar kısa bir sinyalde güvenilir
 * değil; kulak da transient'i tepe seviyesinden duyuyor. Ambiance ise dakikalarca
 * süren bir yatak — orada LUFS doğru araç. İki ses türü, iki ölçü.
 *
 * Her ayrı işaret sesi bir kez hazırlanır (`cue.<ad>.wav`), sonra TEK ffmpeg
 * çağrısında `asplit` + `adelay` ile bütün olaylara dağıtılıp müziğe karışır —
 * olay başına tam boy bir geçiş yazılmaz (03'teki aynı karar).
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { ffmpeg } from '../core/ffmpeg.js';
import { measureVolume } from '../core/loudness.js';
import { durationsMatch, probe } from '../core/probe.js';
import { writeTextFile } from '../core/workspace.js';

/**
 * Üretilen işaret sesleri. Dosya verilmediğinde bunlar kullanılır.
 *
 * WORK ve BREAK ayrı tonda: kullanıcı ekrana bakmadan hangi oturuma geçtiğini
 * anlasın. Tonlar bir oktav aralı (C6 / C5) — lofi müziğin içinde kaybolmayan
 * ama tiz olmayan bir aralık.
 */
export const CUE_SOUNDS = {
  beep: { frequency: 880, durationSeconds: 0.12 },
  work: { frequency: 1046.5, durationSeconds: 0.3 },
  break: { frequency: 523.25, durationSeconds: 0.3 },
};

/** Dosyadan gelen bir işaret sesinin kullanılacak en uzun kısmı (sn). */
const MAX_CUE_SECONDS = 3;

/** Tık sesini önleyen açılış/kapanış (sn). */
const CUE_FADE = { in: 0.005, out: 0.03 };

/**
 * Karışımın tepe değeri bunu aşmasın (dBFS). Müzik zaten -1 civarında tepe
 * yapıyor; işaret sesi onun üstüne eklendiğinde clipping olmasın diye hedef
 * tepe buraya kadar kısılır.
 */
const MAX_CUE_PEAK_DB = -3;

/**
 * Filtre zinciri argv'ye sığmayabilir: 24 turluk bir seçimde ~200 olay var ve
 * her biri filtre metnine bir dal ekliyor. Bu uzunluğun üstünde zincir dosyadan
 * okutulur (`-filter_complex_script`) — Windows'ta komut satırı sınırı 32 KB.
 */
const FILTER_SCRIPT_THRESHOLD = 8000;

const NOOP_LOGGER = { info() {}, warn() {} };

/**
 * İşaret seslerini nihai sesin üzerine bindirir.
 *
 * @param {object} options
 * @param {string} options.audioPath müzik (+ varsa ambiance) karışımı
 * @param {import('../core/pomodoro-plan.js').PomodoroPlan} options.plan
 * @param {ReturnType<typeof import('../core/pomodoro-plan.js').buildCueEvents>} options.cues
 * @param {string} options.outputPath
 * @param {object} options.workspace core/workspace.js örneği
 * @param {{ info: Function, warn: Function }} [options.logger]
 * @param {(seconds: number) => void} [options.onProgress]
 * @returns {Promise<object>} rapor
 */
export async function mixPomodoroCues(options) {
  const {
    audioPath,
    plan,
    cues,
    outputPath,
    workspace,
    logger = NOOP_LOGGER,
    onProgress,
  } = options;

  const warnings = [];
  /** @param {string} message */
  const warn = (message) => {
    warnings.push(message);
    logger.warn(message);
  };

  if (!cues || cues.events.length === 0) {
    throw new Error('Pomodoro işaret olayı yok — bu adım hiç çağrılmamalıydı.');
  }

  // 1 — Müziği tanı: tepe seviyesi işaretlerin hedefini, süresi de
  // doğrulamanın beklentisini verir.
  const music = await probe(audioPath);
  if (!music.hasAudio) {
    throw new Error(`Dosyada ses akışı yok, işaret konulacak müzik bulunamadı: ${audioPath}`);
  }
  const sampleRate = music.sampleRate;
  const musicPeak = (await measureVolume(audioPath)).maxVolume;
  const targetPeakDb = Math.min(musicPeak + plan.cue.volumeDb, MAX_CUE_PEAK_DB);

  logger.info(
    `Müzik tepe ${musicPeak} dBFS, ofset ${plan.cue.volumeDb} dB → ` +
    `işaret sesleri ${targetPeakDb.toFixed(1)} dBFS tepeye ayarlanıyor.`,
  );

  // 2 — Kullanılan her işaret sesini bir kez hazırla. Aynı ses yüzlerce olayda
  // tekrar ediyor; her olayda yeniden üretmenin anlamı yok.
  const usedKinds = cueKindsOf(cues.events);
  /** @type {Map<string, { path: string, duration: number, source: string, peak: number }>} */
  const sounds = new Map();
  for (const kind of usedKinds) {
    sounds.set(kind, await prepareCue({
      kind, plan, targetPeakDb, sampleRate, workspace, logger, warn,
    }));
  }

  // 3 — Tek çağrıda bindirme
  await mkdir(dirname(outputPath), { recursive: true });
  const { filter, inputArgs } = buildCueFilter({ audioPath, events: cues.events, sounds });

  // Zincir uzunsa dosyadan okut: argv sınırına takılmasın.
  let filterArgs;
  if (filter.length > FILTER_SCRIPT_THRESHOLD) {
    const scriptPath = workspace.path('cue-filter.txt');
    await writeTextFile(scriptPath, filter);
    filterArgs = ['-filter_complex_script', scriptPath];
    logger.info(`Filtre zinciri ${filter.length} karakter — dosyadan okutuluyor.`);
  } else {
    filterArgs = ['-filter_complex', filter];
  }

  logger.info(
    `${cues.events.length} işaret bindiriliyor ` +
    `(${usedKinds.map((k) => `${k}: ${cues.events.filter((e) => cueKind(e) === k).length}`).join(', ')}).`,
  );

  await ffmpeg([
    '-i', audioPath,
    ...inputArgs,
    ...filterArgs,
    '-map', '[out]',
    // Ara dosya: float WAV. Ses yalnız montajda bir kez AAC'ye encode edilir.
    '-c:a', 'pcm_f32le',
    '-y', outputPath,
  ], { onProgress });

  // 4 — Çıktıyı doğrula: işaretler sesi uzatmamalı.
  const result = await probe(outputPath);
  if (!durationsMatch(result.duration, music.duration)) {
    throw new Error(
      `Çıktı süresi girdiden farklı: ${result.duration} sn / ${music.duration} sn.`,
    );
  }

  return {
    output: outputPath,
    duration: result.duration,
    eventCount: cues.events.length,
    skippedCount: cues.skipped.length,
    musicPeakDb: musicPeak,
    targetPeakDb: Number(targetPeakDb.toFixed(2)),
    volumeDb: plan.cue.volumeDb,
    sounds: Object.fromEntries(
      [...sounds].map(([kind, sound]) => [kind, { source: sound.source, duration: sound.duration }]),
    ),
    warnings,
  };
}

/**
 * Bir olayın hangi işaret sesini çaldığı.
 *
 * `beep` her oturumda aynı; başlangıç efekti WORK ve BREAK için ayrı ses
 * (spec: `work_start.wav` / `break_start.wav`).
 *
 * @param {{ type: string, kind: string }} event
 * @returns {'beep'|'work'|'break'}
 */
export function cueKind(event) {
  return event.type === 'beep' ? 'beep' : event.kind;
}

/** Olaylarda geçen işaret türleri, sabit sırada (filtre girdileri kararlı olsun). */
function cueKindsOf(events) {
  const used = new Set(events.map(cueKind));
  return ['beep', 'work', 'break'].filter((kind) => used.has(kind));
}

/** Türün config'teki dosya alanı — yol verilmişse ses ondan gelir. */
function cueFileOf(kind, plan) {
  if (kind === 'beep') return plan.cue.beepFile;
  return kind === 'work' ? plan.cue.workStartFile : plan.cue.breakStartFile;
}

/**
 * Bir işaret sesini hazırlar: kaynaktan al, kısalt, tık sesini al, hedef tepeye
 * getir. Üretilen ses ile dosyadan gelen ses AYNI yoldan geçer — seviye kuralı
 * ikisi için de aynı olsun.
 */
async function prepareCue({ kind, plan, targetPeakDb, sampleRate, workspace, logger, warn }) {
  const file = cueFileOf(kind, plan);
  const rawPath = workspace.path(`cue.${kind}.raw.wav`);

  if (file === null) {
    const spec = CUE_SOUNDS[kind];
    await ffmpeg([
      '-f', 'lavfi',
      '-i', `sine=frequency=${spec.frequency}:duration=${spec.durationSeconds}:sample_rate=${sampleRate}`,
      '-af', fadeFilter(spec.durationSeconds),
      '-ac', '2',
      '-c:a', 'pcm_f32le',
      '-y', rawPath,
    ]);
  } else {
    const info = await probe(file);
    if (!info.hasAudio) throw new Error(`İşaret sesi dosyasında ses akışı yok: ${file}`);
    const length = Math.min(info.duration ?? MAX_CUE_SECONDS, MAX_CUE_SECONDS);
    if ((info.duration ?? 0) > MAX_CUE_SECONDS) {
      warn(
        `İşaret sesi "${file}" ${info.duration.toFixed(1)} sn — ilk ${MAX_CUE_SECONDS} sn kullanılıyor ` +
        '(işaret sesi oturumun üstüne taşmamalı).',
      );
    }
    await ffmpeg([
      '-i', file,
      '-af', `aresample=${sampleRate},atrim=end=${length.toFixed(3)},asetpts=N/SR/TB,${fadeFilter(length)}`,
      '-ar', String(sampleRate),
      '-ac', '2',
      '-c:a', 'pcm_f32le',
      '-y', rawPath,
    ]);
  }

  // Ölç → farkı kadar kazanç uygula. Ölçmeden düz bir çarpan vermek, dosyadan
  // gelen seslerde seviyeyi tahmin etmek olurdu.
  const { maxVolume } = await measureVolume(rawPath);
  const gainDb = Number((targetPeakDb - maxVolume).toFixed(2));
  const path = workspace.path(`cue.${kind}.wav`);
  await ffmpeg([
    '-i', rawPath,
    '-af', `volume=${gainDb}dB`,
    '-c:a', 'pcm_f32le',
    '-y', path,
  ]);

  const result = await probe(path);
  logger.info(
    `İşaret sesi "${kind}" hazır: ${file === null ? 'üretildi' : file}, ` +
    `${result.duration} sn, kazanç ${gainDb} dB.`,
  );

  return {
    path,
    duration: result.duration,
    source: file === null ? `sine ${CUE_SOUNDS[kind].frequency} Hz` : file,
    peak: maxVolume,
  };
}

/** Açılış/kapanış — üretilen sine'in sert başlangıcı tık olarak duyuluyor. */
function fadeFilter(durationSeconds) {
  const out = Math.min(CUE_FADE.out, durationSeconds / 2);
  const start = Math.max(0, durationSeconds - out);
  return `afade=t=in:st=0:d=${CUE_FADE.in},afade=t=out:st=${start.toFixed(3)}:d=${out.toFixed(3)}`;
}

/**
 * Bindirme filtresi: her işaret sesi kaç olayda geçiyorsa o kadar kopyaya
 * bölünür (`asplit`), her kopya kendi anına gecikir (`adelay`), hepsi müzikle
 * tek `amix`te toplanır.
 *
 * `amix` ayarları 03-ambient-mix.js ile aynı gerekçeye dayanır: `normalize=0`
 * olmadan amix bütün girdilerin seviyesini girdi sayısına bölüyor — 200 olayda
 * müzik duyulmaz olurdu. `duration=first` çıktıyı müziğin süresinde tutar.
 *
 * Saf fonksiyon: test filtreyi ffmpeg çalıştırmadan denetleyebilsin.
 *
 * @param {{ audioPath: string, events: Array<{ atSeconds: number, type: string, kind: string }>,
 *   sounds: Map<string, { path: string }> }} input
 * @returns {{ filter: string, inputArgs: string[] }}
 */
export function buildCueFilter({ events, sounds }) {
  const kinds = [...sounds.keys()];
  const inputArgs = kinds.flatMap((kind) => ['-i', sounds.get(kind).path]);

  const parts = [];
  const labels = [];

  kinds.forEach((kind, k) => {
    const own = events.filter((event) => cueKind(event) === kind);
    // Girdi indeksi 0 müzik; işaret sesleri 1'den başlar.
    const input = k + 1;
    const copies = own.map((_, i) => `[c${k}_${i}]`);
    parts.push(`[${input}:a]asplit=${own.length}${copies.join('')}`);

    own.forEach((event, i) => {
      const label = `[e${k}_${i}]`;
      // adelay milisaniye ister; all=1 her kanala aynı gecikmeyi verir.
      const delayMs = Math.round(event.atSeconds * 1000);
      parts.push(`${copies[i]}adelay=${delayMs}:all=1${label}`);
      labels.push(label);
    });
  });

  const inputs = labels.length + 1;
  const weights = Array.from({ length: inputs }, () => '1').join(' ');
  parts.push(
    `[0:a]${labels.join('')}amix=inputs=${inputs}:duration=first:weights=${weights}:normalize=0[out]`,
  );

  return { filter: parts.join(';\n'), inputArgs };
}
