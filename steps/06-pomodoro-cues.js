/**
 * Aşama 6 — Pomodoro bip sesleri (her oturumun son saniyelerinde geri sayım).
 *
 * Oturum geçişlerini duyulur kılar. Zamanlar `core/pomodoro-plan.js`
 * `buildCueEvents`'ten gelir (her oturumun — GET READY, WORK, BREAK, videonun
 * son oturumu dahil — bitişinden önce 3 bip); bu katman yalnızca "o anlara
 * sesi nasıl koyarım" sorusunu yanıtlar. Başka ses yok: bip akışının tamamı bu.
 *
 * İki kural spec'ten geliyor ve tasarımı belirliyor:
 *
 *   1. Ses track'lerin İÇİNE gömülmez. Müzik dosyaları da, `mix.wav` da
 *      değişmez; bipler timeline seviyesinde, nihai ses karışımının üzerine
 *      bindirilir. Pomodoro kapatılırsa geriye hiçbir iz kalmaz.
 *   2. Müziği bastırmaz ama rahat duyulur. Seviye müziğin ÖLÇÜLEN tepe
 *      değerine göre belirlenir (`cue.volumeDb`, config'den değişir).
 *
 * Neden tepe (peak) ölçümü, 03-ambient-mix'teki gibi LUFS değil: bip 0.12
 * saniye sürüyor. Entegre gürültü ölçümü bu kadar kısa bir sinyalde güvenilir
 * değil; kulak da transient'i tepe seviyesinden duyuyor. Ambiance ise dakikalarca
 * süren bir yatak — orada LUFS doğru araç. İki ses türü, iki ölçü.
 *
 * Bip bir kez hazırlanır (`cue.beep.wav`), sonra TEK ffmpeg çağrısında `asplit`
 * + `adelay` ile bütün olaylara dağıtılıp müziğe karışır — olay başına tam boy
 * bir geçiş yazılmaz (03'teki aynı karar).
 *
 * Videonun sonundaki ses kararması (fade-out) MÜZİĞE burada, bipler eklenmeden
 * ÖNCE uygulanır: montajdaki genel kararma bipleri de kısardı, oysa videonun
 * son 3 saniyesindeki bipler de net duyulmalı (bkz. `fadeOut`).
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { ffmpeg } from '../core/ffmpeg.js';
import { measureVolume } from '../core/loudness.js';
import { durationsMatch, probe } from '../core/probe.js';
import { writeTextFile } from '../core/workspace.js';

/** Üretilen bip. `cue.beepFile` verilmezse bu kullanılır. */
export const CUE_BEEP = { frequency: 880, durationSeconds: 0.12 };

/** Dosyadan gelen bir bip sesinin kullanılacak en uzun kısmı (sn). */
const MAX_CUE_SECONDS = 3;

/** Tık sesini önleyen açılış/kapanış (sn). */
const CUE_FADE = { in: 0.005, out: 0.03 };

/**
 * Karışımın tepe değeri bunu aşmasın (dBFS). Müzik zaten -1 civarında tepe
 * yapıyor; bip onun üstüne eklendiğinde clipping olmasın diye hedef tepe
 * buraya kadar kısılır.
 */
const MAX_CUE_PEAK_DB = -3;

/**
 * Filtre zinciri argv'ye sığmayabilir: 24 turluk bir seçimde ~150 olay var ve
 * her biri filtre metnine bir dal ekliyor. Bu uzunluğun üstünde zincir dosyadan
 * okutulur (`-filter_complex_script`) — Windows'ta komut satırı sınırı 32 KB.
 */
const FILTER_SCRIPT_THRESHOLD = 8000;

const NOOP_LOGGER = { info() {}, warn() {} };

/**
 * Bipleri nihai sesin üzerine bindirir.
 *
 * @param {object} options
 * @param {string} options.audioPath müzik (+ varsa ambiance) karışımı
 * @param {import('../core/pomodoro-plan.js').PomodoroPlan} options.plan
 * @param {ReturnType<typeof import('../core/pomodoro-plan.js').buildCueEvents>} options.cues
 * @param {string} options.outputPath
 * @param {object} options.workspace core/workspace.js örneği
 * @param {number} [options.fadeOut] videonun sonundaki ses kararması (sn): MÜZİĞE, bipler
 *   eklenmeden önce uygulanır; 0 = yok. Montajda ayrıca ses kararması yapılmamalı.
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
    fadeOut = 0,
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
    throw new Error('Pomodoro bip olayı yok — bu adım hiç çağrılmamalıydı.');
  }

  // 1 — Müziği tanı: tepe seviyesi bipin hedefini, süresi de
  // doğrulamanın beklentisini verir.
  const music = await probe(audioPath);
  if (!music.hasAudio) {
    throw new Error(`Dosyada ses akışı yok, bip konulacak müzik bulunamadı: ${audioPath}`);
  }
  const sampleRate = music.sampleRate;
  const musicPeak = (await measureVolume(audioPath)).maxVolume;
  const targetPeakDb = Math.min(musicPeak + plan.cue.volumeDb, MAX_CUE_PEAK_DB);

  logger.info(
    `Müzik tepe ${musicPeak} dBFS, ofset ${plan.cue.volumeDb} dB → ` +
    `bip ${targetPeakDb.toFixed(1)} dBFS tepeye ayarlanıyor.`,
  );

  // 2 — Bipi bir kez hazırla: aynı ses yüzlerce olayda tekrar ediyor.
  const beep = await prepareBeep({ plan, targetPeakDb, sampleRate, workspace, logger, warn });

  // 3 — Tek çağrıda bindirme
  await mkdir(dirname(outputPath), { recursive: true });
  const { filter, inputArgs } = buildCueFilter({
    events: cues.events,
    soundPath: beep.path,
    musicSeconds: music.duration,
    fadeOut,
  });

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

  logger.info(`${cues.events.length} bip bindiriliyor.`);

  await ffmpeg([
    '-i', audioPath,
    ...inputArgs,
    ...filterArgs,
    '-map', '[out]',
    // Ara dosya: float WAV. Ses yalnız montajda bir kez AAC'ye encode edilir.
    '-c:a', 'pcm_f32le',
    '-y', outputPath,
  ], { onProgress });

  // 4 — Çıktıyı doğrula: bipler sesi uzatmamalı.
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
    musicPeakDb: musicPeak,
    targetPeakDb: Number(targetPeakDb.toFixed(2)),
    volumeDb: plan.cue.volumeDb,
    beep: { source: beep.source, duration: beep.duration },
    warnings,
  };
}

/**
 * Bipi hazırlar: kaynaktan al, kısalt, tık sesini al, hedef tepeye getir.
 * Üretilen ses ile dosyadan gelen ses AYNI yoldan geçer — seviye kuralı
 * ikisi için de aynı olsun.
 */
async function prepareBeep({ plan, targetPeakDb, sampleRate, workspace, logger, warn }) {
  const file = plan.cue.beepFile;
  const rawPath = workspace.path('cue.beep.raw.wav');

  if (file === null) {
    await ffmpeg([
      '-f', 'lavfi',
      '-i', `sine=frequency=${CUE_BEEP.frequency}:duration=${CUE_BEEP.durationSeconds}:sample_rate=${sampleRate}`,
      '-af', fadeFilter(CUE_BEEP.durationSeconds),
      '-ac', '2',
      '-c:a', 'pcm_f32le',
      '-y', rawPath,
    ]);
  } else {
    const info = await probe(file);
    if (!info.hasAudio) throw new Error(`Bip dosyasında ses akışı yok: ${file}`);
    const length = Math.min(info.duration ?? MAX_CUE_SECONDS, MAX_CUE_SECONDS);
    if ((info.duration ?? 0) > MAX_CUE_SECONDS) {
      warn(
        `Bip dosyası "${file}" ${info.duration.toFixed(1)} sn — ilk ${MAX_CUE_SECONDS} sn kullanılıyor ` +
        '(bip bir sonraki bipin üstüne taşmamalı).',
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
  const path = workspace.path('cue.beep.wav');
  await ffmpeg([
    '-i', rawPath,
    '-af', `volume=${gainDb}dB`,
    '-c:a', 'pcm_f32le',
    '-y', path,
  ]);

  const result = await probe(path);
  logger.info(
    `Bip hazır: ${file === null ? 'üretildi' : file}, ${result.duration} sn, kazanç ${gainDb} dB.`,
  );

  return {
    path,
    duration: result.duration,
    source: file === null ? `sine ${CUE_BEEP.frequency} Hz` : file,
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
 * Bindirme filtresi: bip, olay sayısı kadar kopyaya bölünür (`asplit`), her
 * kopya kendi anına gecikir (`adelay`), hepsi müzikle tek `amix`te toplanır.
 *
 * `amix` ayarları 03-ambient-mix.js ile aynı gerekçeye dayanır: `normalize=0`
 * olmadan amix bütün girdilerin seviyesini girdi sayısına bölüyor — 150 olayda
 * müzik duyulmaz olurdu. `duration=first` çıktıyı müziğin süresinde tutar.
 *
 * `fadeOut > 0` ise müziğin son `fadeOut` saniyesi kararır (bipler hariç).
 *
 * Saf fonksiyon: test filtreyi ffmpeg çalıştırmadan denetleyebilsin.
 *
 * @param {{ events: Array<{ atSeconds: number }>, soundPath: string,
 *   musicSeconds?: number, fadeOut?: number }} input
 * @returns {{ filter: string, inputArgs: string[] }}
 */
export function buildCueFilter({ events, soundPath, musicSeconds = 0, fadeOut = 0 }) {
  const parts = [];

  // Girdi 0 müzik, girdi 1 bip.
  const copies = events.map((_, i) => `[c${i}]`);
  parts.push(`[1:a]asplit=${events.length}${copies.join('')}`);

  const labels = events.map((event, i) => {
    // adelay milisaniye ister; all=1 her kanala aynı gecikmeyi verir.
    const delayMs = Math.round(event.atSeconds * 1000);
    parts.push(`${copies[i]}adelay=${delayMs}:all=1[e${i}]`);
    return `[e${i}]`;
  });

  let music = '[0:a]';
  if (fadeOut > 0 && musicSeconds > 0) {
    const start = Math.max(0, musicSeconds - fadeOut);
    parts.push(`[0:a]afade=t=out:st=${start}:d=${fadeOut}[music]`);
    music = '[music]';
  }

  const inputs = labels.length + 1;
  const weights = Array.from({ length: inputs }, () => '1').join(' ');
  parts.push(
    `${music}${labels.join('')}amix=inputs=${inputs}:duration=first:weights=${weights}:normalize=0[out]`,
  );

  return { filter: parts.join(';\n'), inputArgs: ['-i', soundPath] };
}
