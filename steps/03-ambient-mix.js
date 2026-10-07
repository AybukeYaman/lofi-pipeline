/**
 * Aşama 3 — Ambiance karıştırma.
 *
 * Videonun müziğinin üzerine bir ya da birden fazla ortam sesini, videonun
 * TAMAMI boyunca, dikişi duyulmayan bir döngüyle ekler.
 *
 * Bölüm 7'deki elle iterasyonun (I=-26 → -28 → -29 → -30, 6 deneme) yerine:
 * müziği ölç, hedefi farktan hesapla, kısa örnekle doğrula, sonra üret.
 * Mutlak bir I değeri hiçbir yere yazılmaz.
 *
 * Döngü nasıl kuruluyor — üç katman:
 *
 *   1. HAZIRLIK   Her parça bir kez, kendi uzunluğunda, kendi hedef seviyesine
 *                 normalize edilir (`*.ambient<i>.wav`). Ağır zincir
 *                 (aresample + iki geçişli loudnorm) 48 dakikalık döngüye
 *                 değil yalnız bu kısa dosyaya uygulanır.
 *   2. DÖNGÜ BİRİMİ  Hazır dosyadan, kuyruğu kendi başına harmanlanmış bir
 *                 "döngü birimi" üretilir (`makeSeamlessLoop`). Bu birim uç uca
 *                 eklendiğinde dikişte tık duyulmaz. `sequence` modunda birim
 *                 bütün parçaların crossfade'li turudur.
 *   3. KARIŞIM    Birimler `-stream_loop -1` ile sonsuz tekrarlanıp tek bir
 *                 `amix` çağrısında müziğe karışır; `duration=first` fazlasını
 *                 müzik süresinde keser. Video ne kadar uzun olursa olsun
 *                 döngü onu karşılar, kısaysa kesilir.
 *
 * Seviye: her parçanın ofseti özelden genele çözülür (parça → plan → config),
 * bkz. `core/ambient-plan.js` `offsetDbFor`.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, parse } from 'node:path';

import {
  DEFAULT_FADE_IN_SECONDS,
  offsetDbFor,
} from '../core/ambient-plan.js';
import { ffmpeg } from '../core/ffmpeg.js';
import {
  loudnessMatches,
  loudnormFilter,
  measureLoudness,
  measureVolume,
  targetLoudnessFor,
} from '../core/loudness.js';
import { durationsMatch, probe } from '../core/probe.js';

/**
 * Varsayılanlar.
 *
 * `ambientOffsetDb` ULAŞILAN seviyeler arasındaki fark, filtreye yazılan
 * parametre farkı değil. Yayınlanan videoda müzik -14.78 LUFS, ambient'in
 * gerçekte ulaştığı seviye -33.61 LUFS → fark -18.8 LU.
 *
 * Elle bulunan "I=-30" bu sayı DEĞİLDİR: o, tek geçişli loudnorm'a verilen
 * parametreydi ve tek geçiş hedefi ıskaladığı için ulaşılan seviye -33.6 oldu.
 * İkisini karıştırmamak için burada iki geçişli loudnorm kullanılıyor —
 * o modda hedef ile ulaşılan seviye aynı şey.
 */
const DEFAULTS = {
  ambientOffsetDb: -18.8,
  fadeOut: 5,
  fadeIn: DEFAULT_FADE_IN_SECONDS,
  truePeak: -6,
  loudnessRange: 7,
  /** Doğrulama örneğinin alınacağı yer — videonun ortalarından kısa bir kesit. */
  sample: { startSeconds: 600, duration: 30 },
};

/**
 * Harman için gereken en kısa parça: döngü birimi `seam (C) + gövde (D-2C)`
 * olduğundan gövdenin boş kalmaması için D > 2C şart. 3 kat alıyoruz ki
 * gövde de duyulur uzunlukta kalsın.
 */
const MIN_CROSSFADE_RATIO = 3;

/** Bundan kısa bir harman kulağa sert dikişten farklı gelmiyor. */
const MIN_CROSSFADE_SECONDS = 0.1;

const NOOP_LOGGER = { info() {}, warn() {} };

/**
 * Ambiance planını müziğin üzerine karıştırır.
 *
 * @param {object} options
 * @param {string} options.audioPath müziği hazır ses (ambient'siz)
 * @param {import('../core/ambient-plan.js').AmbientPlan} options.plan
 *   normalize edilmiş Ambiance planı (mutlak yollu) — `core/config.js` üretir
 * @param {string} options.outputPath
 * @param {object} options.workspace core/workspace.js örneği (ara dosyalar için)
 * @param {number} [options.ambientOffsetDb] plan/parça ofseti yoksa kullanılır
 * @param {number} [options.fadeOut] sondaki fade süresi (sn)
 * @param {number} [options.fadeIn] baştaki fade süresi (sn) — ani başlamayı önler
 * @param {{ startSeconds: number, duration: number }|null} [options.sample]
 *   null verilirse doğrulama atlanır (hızlı ama körlemesine)
 * @param {{ info: Function, warn: Function }} [options.logger]
 * @param {(seconds: number) => void} [options.onProgress]
 * @returns {Promise<object>} rapor
 */
export async function mixAmbient(options) {
  const {
    audioPath,
    plan,
    outputPath,
    workspace,
    ambientOffsetDb = DEFAULTS.ambientOffsetDb,
    fadeOut = DEFAULTS.fadeOut,
    fadeIn = DEFAULTS.fadeIn,
    sample = DEFAULTS.sample,
    logger = NOOP_LOGGER,
    onProgress,
  } = options;

  if (!plan || plan.tracks.length === 0) {
    throw new Error('Ambiance planı boş — bu adım hiç çağrılmamalıydı.');
  }

  const warnings = [];
  /** @param {string} message */
  const warn = (message) => {
    warnings.push(message);
    logger.warn(message);
  };

  // 1 — Müziği tanı, hedef seviyeleri türet
  const musicFile = await probe(audioPath);
  if (!musicFile.hasAudio) {
    throw new Error(`Dosyada ses akışı yok, karıştıracak müzik bulunamadı: ${audioPath}`);
  }
  const sampleRate = musicFile.sampleRate;

  const sampleWindow = sample ? fitSample(sample, musicFile.duration) : null;
  if (sampleWindow && sampleWindow.startSeconds !== sample.startSeconds) {
    logger.info(
      `Müzik ${musicFile.duration} sn — doğrulama kesiti ${sample.startSeconds}. sn'ye sığmıyor, ` +
      `${sampleWindow.startSeconds}. sn'den ${sampleWindow.duration} sn alınıyor.`,
    );
  }
  const music = await measureLoudness(audioPath, sampleWindow ?? {});

  // 2 — Her parçayı bir kez, kendi uzunluğunda, kendi hedefine hazırla
  const stem = parse(outputPath).name;
  const shareDb = layerShareDb(plan);
  if (shareDb !== 0) {
    logger.info(
      `${plan.tracks.length} ses üst üste binecek — toplamları ofseti aşmasın diye ` +
      `her birine ${shareDb} dB pay düşüyor.`,
    );
  }
  const prepared = [];
  for (let i = 0; i < plan.tracks.length; i++) {
    prepared.push(await prepareTrack({
      track: plan.tracks[i],
      index: i,
      plan,
      stem,
      musicI: music.inputI,
      ambientOffsetDb,
      shareDb,
      sampleRate,
      workspace,
      logger,
    }));
  }

  // 3 — Döngü birimleri. layer: parça başına bir birim (her biri bağımsız
  // döner). sequence: bütün parçaların turu tek birim.
  const units = await buildLoopUnits({
    plan, prepared, stem, sampleRate, workspace, logger, warn,
  });

  // 4 — Kısa örneklerle doğrula
  const verification = sampleWindow
    ? await verifyLevels({
      audioPath, units, workspace, sample: sampleWindow,
      musicI: music.inputI, prepared, logger, warn,
    })
    : null;

  if (verification === null) {
    warn('Doğrulama örneği atlandı (sample: null) — seviye körlemesine uygulanıyor.');
  }

  // 5 — Nihai karışım: tek ffmpeg çağrısı, bütün birimler sonsuz döngüde.
  // Birimleri tek tek tam boy karıştırmak her parça için 48 dakikalık bir WAV
  // daha yazıyordu; tek amix hem N-1 geçişi hem o dosyaları ortadan kaldırır.
  await mkdir(dirname(outputPath), { recursive: true });

  const fadeInSeconds = clampFade(fadeIn, musicFile.duration);
  const fadeOutSeconds = clampFade(fadeOut, musicFile.duration);
  const fadeStart = Math.max(0, musicFile.duration - fadeOutSeconds);

  const inputArgs = ['-i', audioPath];
  const branches = [];
  for (let i = 0; i < units.length; i++) {
    inputArgs.push('-stream_loop', '-1', '-i', units[i].path);
    branches.push(
      `[${i + 1}:a]` +
      `afade=t=in:st=0:d=${fadeInSeconds},` +
      `afade=t=out:st=${fadeStart}:d=${fadeOutSeconds}` +
      `[amb${i}]`,
    );
  }

  const amixInputs = units.map((_, i) => `[amb${i}]`).join('');
  const filterComplex =
    `${branches.join(';')};` +
    `[0:a]${amixInputs}${amix(units.length + 1)}[out]`;

  logger.info(
    `Nihai ses karıştırma başlıyor — ${units.length} döngü birimi, ` +
    `mod ${plan.mode} (video yok).`,
  );

  await ffmpeg([
    ...inputArgs,
    '-filter_complex', filterComplex,
    '-map', '[out]',
    // Ara dosya: float WAV. Ses yalnız montajda bir kez AAC'ye encode edilir.
    '-c:a', 'pcm_f32le',
    '-y', outputPath,
  ], { onProgress });

  // 6 — Çıktıyı doğrula
  const result = await probe(outputPath);

  if (!durationsMatch(result.duration, musicFile.duration)) {
    throw new Error(
      `Çıktı süresi girdiden farklı: ${result.duration} sn / ${musicFile.duration} sn.`,
    );
  }

  return {
    output: outputPath,
    duration: result.duration,
    mode: plan.mode,
    crossfade: plan.crossfade,
    shareDb,
    musicI: music.inputI,
    // Geriye dönük alan: regresyon karşılaştırması (test/regression.js) bunu
    // `ambientMix.targetI` olarak okuyor. Çok parçada parçaların birlikte
    // ulaştığı seviye.
    ambientTargetI: combinedTargetI(prepared.map((p) => p.targetI)),
    tracks: prepared.map((p) => ({
      source: p.track.path,
      offsetDb: p.offsetDb,
      targetI: p.targetI,
      sourceI: p.measured.inputI,
      sourceDuration: p.duration,
      sampleRate: p.sampleRate,
      resampledTo: p.sampleRate === sampleRate ? null : sampleRate,
      maxVolume: p.maxVolume,
      loudnormPasses: 2,
    })),
    loops: units.map((unit) => ({
      source: unit.sources,
      duration: unit.duration,
      crossfade: unit.crossfade,
      seamless: unit.seamless,
    })),
    audio: { codec: result.audioCodec, sampleRate: result.sampleRate },
    fade: { in: fadeInSeconds, out: { start: fadeStart, duration: fadeOutSeconds } },
    verification,
    warnings,
  };
}

/**
 * Bir parçayı ölçüp kendi hedef seviyesine normalize eder.
 *
 * Linear (iki geçişli) loudnorm dosyanın kendi ölçümünden gelen DÜZ bir
 * kazançtır → döngüde tekrarlandığında da aynı kalır. Tek geçişli dinamik mod
 * döngünün her turunda farklı davranır, bu yüzden kullanılmıyor.
 */
async function prepareTrack(params) {
  const {
    track, index, plan, stem, musicI, ambientOffsetDb, shareDb, sampleRate, workspace, logger,
  } = params;

  const info = await probe(track.path);
  if (!info.hasAudio) {
    throw new Error(`Ambiance dosyasında ses akışı yok: ${track.path}`);
  }
  if (info.sampleRate !== sampleRate) {
    logger.info(
      `Ambiance "${track.path}" ${info.sampleRate} Hz, hedef ${sampleRate} Hz — ` +
      'aresample uygulanacak.',
    );
  }

  // Pay yalnızca kendi seviyesini söylemeyen parçalara uygulanır: kullanıcı
  // bir sese özel volumeDb verdiyse istediği şey odur, bölüştürülmez.
  const requested = offsetDbFor(track, plan, ambientOffsetDb);
  const offsetDb = Number((requested + (track.volumeDb === null ? shareDb : 0)).toFixed(2));
  const targetI = targetLoudnessFor(musicI, offsetDb);

  const measured = await measureLoudness(track.path);
  const volume = await measureVolume(track.path);
  if (volume.maxVolume >= -0.1) {
    logger.info(
      `Ambiance tepe seviyesi ${volume.maxVolume} dB — düz çarpan clipping ` +
      'yapardı, loudnorm kullanılıyor.',
    );
  }

  logger.info(
    `Müzik ${musicI} LUFS, ofset ${offsetDb} LU → "${track.path}" hedefi I=${targetI}`,
  );

  // aresample önce gelir: ambient 44.1 kHz, müzik 48 kHz. Eşitlenmezse pitch
  // kayması olur (bölüm 7).
  const loudnorm = loudnormFilter({
    targetI, truePeak: DEFAULTS.truePeak, loudnessRange: DEFAULTS.loudnessRange, measured,
  });
  const path = workspace.path(`${stem}.ambient${index}.wav`);
  await ffmpeg([
    '-i', track.path,
    '-af', `aresample=${sampleRate},${loudnorm},aresample=${sampleRate}`,
    '-ar', String(sampleRate),
    '-c:a', 'pcm_f32le',
    '-y', path,
  ]);

  const result = await probe(path);

  return {
    track, index, path, offsetDb, targetI, measured,
    maxVolume: volume.maxVolume,
    sampleRate: info.sampleRate,
    duration: result.duration,
  };
}

/**
 * Plandan döngü birimleri üretir — mod dağıtımının tek yeri.
 *
 * Yeni bir mod (ör. `shuffle`) eklemek: `core/ambient-plan.js` içindeki
 * `AMBIENT_MODES`'a adı yaz, buraya bir dal ekle. Karışım tarafı birimleri
 * ayırt etmiyor, kaç tane gelirse `amix`e onu veriyor.
 */
async function buildLoopUnits({ plan, prepared, stem, sampleRate, workspace, logger, warn }) {
  if (plan.mode === 'sequence') {
    const cycle = await buildSequenceCycle({
      prepared, stem, crossfade: plan.crossfade, sampleRate, workspace, logger, warn,
    });
    return [await makeSeamlessLoop({
      input: cycle,
      outputPath: workspace.path(`${stem}.loop0.wav`),
      crossfade: plan.crossfade,
      sampleRate,
      logger,
      warn,
    })];
  }

  // layer — her parça kendi uzunluğunda bağımsız döner
  const units = [];
  for (const p of prepared) {
    units.push(await makeSeamlessLoop({
      input: { path: p.path, duration: p.duration, sources: [p.track.path] },
      outputPath: workspace.path(`${stem}.loop${p.index}.wav`),
      crossfade: plan.crossfade,
      sampleRate,
      logger,
      warn,
    }));
  }
  return units;
}

/**
 * `sequence` modu: hazır parçaları sırayla, aralarında crossfade ile tek bir
 * tura bağlar. Tur süresi = Σ süreler − (parça sayısı − 1) × crossfade.
 *
 * Tek parça varsa tur parçanın kendisidir (crossfade edilecek komşu yok).
 */
async function buildSequenceCycle({
  prepared, stem, crossfade, sampleRate, workspace, logger, warn,
}) {
  if (prepared.length === 1) {
    const only = prepared[0];
    return { path: only.path, duration: only.duration, sources: [only.track.path] };
  }

  // Harman komşu parçaların her ikisinden de süre yiyor; en kısa parçanın
  // yarısını geçemez, yoksa acrossfade parçayı tamamen tüketir.
  const shortest = Math.min(...prepared.map((p) => p.duration));
  const effective = Math.min(crossfade, shortest / 2);
  if (effective < crossfade) {
    logger.info(
      `Sıra harmanı ${crossfade} sn istendi, en kısa parça ${shortest.toFixed(2)} sn — ` +
      `${effective.toFixed(2)} sn'ye indirildi.`,
    );
  }

  const parts = [];
  let previous = '[0:a]';
  let duration = prepared[0].duration;
  for (let i = 1; i < prepared.length; i++) {
    const label = i === prepared.length - 1 ? '[cycle]' : `[seq${i}]`;
    parts.push(
      `${previous}[${i}:a]acrossfade=d=${effective.toFixed(3)}:c1=tri:c2=tri${label}`,
    );
    duration += prepared[i].duration - effective;
    previous = label;
  }

  const path = workspace.path(`${stem}.cycle.wav`);
  await ffmpeg([
    ...prepared.flatMap((p) => ['-i', p.path]),
    '-filter_complex', parts.join(';'),
    '-map', '[cycle]',
    '-ar', String(sampleRate),
    '-c:a', 'pcm_f32le',
    '-y', path,
  ]);

  const result = await probe(path);
  if (!durationsMatch(result.duration, duration, 0.5)) {
    warn(
      `Sıra turu beklenenden farklı çıktı: ${result.duration} sn, beklenen ` +
      `~${duration.toFixed(2)} sn.`,
    );
  }

  logger.info(
    `Sıra turu hazır: ${prepared.length} parça, ${result.duration} sn, ` +
    `harman ${effective.toFixed(2)} sn.`,
  );

  return {
    path,
    duration: result.duration,
    sources: prepared.map((p) => p.track.path),
  };
}

/**
 * Dikişsiz döngü birimi.
 *
 * Sorun: `-stream_loop` dosyayı uç uca ekler. Dosyanın sonundaki dalga biçimi
 * başındakiyle uyuşmadığı için her turda bir tık duyulur.
 *
 * Çözüm: dikişi birimin İÇİNE al. D uzunluğundaki hazır dosyadan C saniye
 * harmanla:
 *
 *   seam  = acrossfade( dosya[D-C .. D], dosya[0 .. C] )   → C sn
 *   gövde = dosya[C .. D-C]                                → D-2C sn
 *   birim = seam + gövde                                   → D-C sn
 *
 * Birim tekrarlandığında: gövde D-C'de biter, hemen ardından gelen seam tam o
 * noktadan (D-C) başlayıp dosyanın başına (C) yumuşakça bağlanır, gövde de
 * C'den devam eder. İki tarafta da süreklilik var → dikiş duyulmaz.
 *
 * Harman sığmıyorsa (D ≤ 3C) C küçültülür; anlamlı bir harman kalmıyorsa
 * birim hazır dosyanın kendisi olur ve uyarı verilir.
 */
async function makeSeamlessLoop({ input, outputPath, crossfade, sampleRate, logger, warn }) {
  const base = {
    path: input.path,
    duration: input.duration,
    sources: input.sources,
    crossfade: 0,
    seamless: false,
  };

  if (!(crossfade > 0)) {
    logger.info('Harman kapalı (crossfade: 0) — döngü dikişi sert eklenecek.');
    return base;
  }

  const effective = Math.min(crossfade, input.duration / MIN_CROSSFADE_RATIO);
  if (effective < MIN_CROSSFADE_SECONDS) {
    warn(
      `Ambiance ${input.duration.toFixed(2)} sn — ${crossfade} sn harman için fazla kısa, ` +
      'döngü dikişi harmansız kalacak (tekrarda tık duyulabilir).',
    );
    return base;
  }
  if (effective < crossfade) {
    logger.info(
      `Döngü harmanı ${crossfade} sn istendi, parça ${input.duration.toFixed(2)} sn — ` +
      `${effective.toFixed(2)} sn'ye indirildi.`,
    );
  }

  const c = Number(effective.toFixed(3));
  const bodyStart = c;
  const bodyEnd = Number((input.duration - c).toFixed(3));
  // atrim sonrası asetpts: concat girdilerin 0'dan başlayan zaman damgası ister.
  const reset = 'asetpts=N/SR/TB';
  const filterComplex =
    '[0:a]asplit=3[h0][b0][t0];' +
    `[h0]atrim=start=0:end=${c},${reset}[head];` +
    `[t0]atrim=start=${bodyEnd},${reset}[tail];` +
    `[b0]atrim=start=${bodyStart}:end=${bodyEnd},${reset}[body];` +
    `[tail][head]acrossfade=d=${c}:c1=tri:c2=tri[seam];` +
    '[seam][body]concat=n=2:v=0:a=1[out]';

  await ffmpeg([
    '-i', input.path,
    '-filter_complex', filterComplex,
    '-map', '[out]',
    '-ar', String(sampleRate),
    '-c:a', 'pcm_f32le',
    '-y', outputPath,
  ]);

  const result = await probe(outputPath);
  const expected = input.duration - c;
  if (!durationsMatch(result.duration, expected, 0.5)) {
    warn(
      `Döngü birimi beklenenden farklı çıktı: ${result.duration} sn, beklenen ` +
      `~${expected.toFixed(2)} sn.`,
    );
  }

  logger.info(
    `Dikişsiz döngü birimi hazır: ${result.duration} sn (harman ${c} sn).`,
  );

  return {
    path: outputPath,
    duration: result.duration,
    sources: input.sources,
    crossfade: c,
    seamless: true,
  };
}

/**
 * Doğrulama kesitini videoya sığdırır. Kesit videonun sonunu aşıyorsa (kısa
 * video) ölçülecek ses kalmaz ve loudnorm NaN döndürür; bu durumda kesit
 * videonun ortasına alınır, süre de gerekirse videoya indirilir.
 *
 * @param {{ startSeconds: number, duration: number }} sample
 * @param {number} videoDuration
 * @returns {{ startSeconds: number, duration: number }}
 */
export function fitSample(sample, videoDuration) {
  if (sample.startSeconds + sample.duration <= videoDuration) return sample;
  const duration = Math.min(sample.duration, videoDuration);
  const startSeconds = Number(Math.max(0, (videoDuration - duration) / 2).toFixed(3));
  return { startSeconds, duration };
}

/** Fade süresi sesin kendisinden uzun olamaz. */
function clampFade(seconds, duration) {
  if (!(seconds > 0)) return 0;
  return Number(Math.min(seconds, duration / 2).toFixed(3));
}

/**
 * amix ayarları.
 *
 * `weights=...:normalize=0` olmadan amix girdilerin seviyesini girdi sayısına
 * bölüyor; bölüm 7'de bu "sanki bütün ses artıyor gibi" olarak fark edildi.
 * Her girdinin ağırlığı 1 — seviyeyi parça başına `loudnorm` ayarlıyor, amix
 * yalnız toplama yapıyor.
 *
 * duration=first → çıktı müziğin süresi kadar; ambient döngüsü onu uzatmıyor,
 * ambient müzikten kısaysa da döngü boşluk bırakmıyor.
 *
 * @param {number} inputs müzik dahil girdi sayısı
 */
function amix(inputs) {
  const weights = Array.from({ length: inputs }, () => '1').join(' ');
  return `amix=inputs=${inputs}:duration=first:weights=${weights}:normalize=0`;
}

/**
 * Kısa örneklerle iki şeyi doğrular:
 *   1. Ambiance yatağı gerçekten hedef seviyeye indi mi (loudnorm tuttu mu).
 *   2. amix müziğin seviyesini düşürdü mü (normalize=0 çalışıyor mu).
 *
 * Örnekler nihai karışımla aynı şekilde, döngü birimlerinden alınır. PCM
 * üretiliyor — encoder renklendirmesi ölçümü kirletmesin. 48 dakika yerine
 * 30 saniye işleniyor, döngü saniyeler sürüyor.
 *
 * Hedef: tek parçada parçanın hedefi; çok parçada toplamın gücü (eşit güçte
 * kabul edilmeyen kaynaklar toplandığında seviye 10·log10(Σ10^(Iᵢ/10)) olur).
 */
async function verifyLevels(params) {
  const { audioPath, units, workspace, sample, musicI, prepared, logger, warn } = params;

  const seek = ['-ss', String(sample.startSeconds), '-t', String(sample.duration)];
  const loopInputs = units.flatMap((unit) => ['-stream_loop', '-1', ...seek, '-i', unit.path]);
  const bedMix = units.length === 1
    ? null
    : `${units.map((_, i) => `[${i}:a]`).join('')}${amix(units.length)}[bed]`;

  // 1 — Ambiance yatağı tek başına (bütün birimler toplanmış hali)
  const bedSample = workspace.path('verify-ambient.wav');
  await ffmpeg([
    ...loopInputs,
    ...(bedMix ? ['-filter_complex', bedMix, '-map', '[bed]'] : []),
    '-c:a', 'pcm_s16le',
    '-y', bedSample,
  ]);
  const bedMeasured = await measureLoudness(bedSample);

  // 2 — Karışımın kendisi
  const mixSample = workspace.path('verify-mix.wav');
  const mixInputs = units.map((_, i) => `[${i + 1}:a]`).join('');
  await ffmpeg([
    ...seek, '-i', audioPath,
    ...loopInputs,
    '-filter_complex', `[0:a]${mixInputs}${amix(units.length + 1)}[out]`,
    '-map', '[out]',
    '-c:a', 'pcm_s16le',
    '-y', mixSample,
  ]);
  const mixMeasured = await measureLoudness(mixSample);

  const targetI = combinedTargetI(prepared.map((p) => p.targetI));
  const bedOnTarget = loudnessMatches(bedMeasured.inputI, targetI);
  // Karışım müzikten daha sessiz çıkıyorsa amix seviyeyi kısıyor demektir.
  const musicPreserved = mixMeasured.inputI >= musicI - 1;

  logger.info(
    `Doğrulama: Ambiance yatağı ${bedMeasured.inputI} LUFS (hedef ${targetI}), ` +
    `karışım ${mixMeasured.inputI} LUFS (müzik ${musicI})`,
  );

  if (!bedOnTarget) {
    warn(
      `Ambiance hedefi tutturamadı: ${bedMeasured.inputI} LUFS, hedef ${targetI} LUFS.`,
    );
  }
  if (!musicPreserved) {
    warn(
      `Karışım müzikten sessiz çıktı (${mixMeasured.inputI} < ${musicI} LUFS) — ` +
      'amix seviyeyi kısıyor olabilir, weights/normalize ayarını kontrol et.',
    );
  }

  return {
    sample,
    ambientMeasuredI: bedMeasured.inputI,
    ambientTargetI: targetI,
    ambientOnTarget: bedOnTarget,
    mixI: mixMeasured.inputI,
    musicI,
    musicPreserved,
  };
}

/**
 * `layer` modunda her parçaya düşen pay (dB, negatif).
 *
 * Sorun: iki ses üst üste bindiğinde güçleri toplanır, birlikte ulaştıkları
 * seviye tek sesten ~3 LU yüksek olur (dört ses ~6 LU). Ofset parça başına
 * uygulanırsa kullanıcı ne kadar çok ses seçerse arka plan o kadar öne
 * çıkar — "müziğin üstüne çıkmasın" kuralı bozulur.
 *
 * Çözüm: ofset TOPLAMA uygulanır, parçalar onu bölüşür. N eşit parça için her
 * birinden 10·log10(N) dB düşülür; toplandıklarında tam ofsete dönerler. Böylece
 * 1 ses de 4 ses de müziğin aynı kadar altında kalır.
 *
 * `sequence` modunda bölüştürme yok: o modda aynı anda tek ses çalıyor.
 *
 * @param {import('../core/ambient-plan.js').AmbientPlan} plan
 * @returns {number} 0 ya da negatif dB
 */
export function layerShareDb(plan) {
  if (plan.mode !== 'layer') return 0;
  // Kendi seviyesi verilmiş parçalar bölüşmeye girmez.
  const sharing = plan.tracks.filter((track) => track.volumeDb === null).length;
  if (sharing < 2) return 0;
  return Number((-10 * Math.log10(sharing)).toFixed(2));
}

/**
 * Üst üste binen parçaların birlikte ulaşacağı seviye.
 *
 * İlişkisiz kaynakların güçleri toplanır: I = 10·log10(Σ 10^(Iᵢ/10)).
 * İki eşit parça ≈ +3 LU. Tek parçada kendi hedefini döndürür.
 *
 * `sequence` modunda tek birim var → zaten tek hedef.
 *
 * @param {number[]} targets
 * @returns {number}
 */
export function combinedTargetI(targets) {
  if (targets.length === 1) return targets[0];
  const power = targets.reduce((sum, i) => sum + 10 ** (i / 10), 0);
  return Number((10 * Math.log10(power)).toFixed(1));
}
