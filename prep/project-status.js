/**
 * Proje durumu — klasöre bakıp "sıradaki adım ne?" sorusunu yanıtlar.
 *
 * Tek sorumluluk: okumak ve karar vermek. Hiçbir dosya yazmaz, komut
 * çalıştırmaz, durum saklamaz — her seferinde diskten okunur, böylece
 * dosyalar elle taşınsa da doğru adım bulunur (Aşama 8 kararı).
 *
 * inspectProject (okuma) ile nextStep (saf karar) ayrı: karar tablosu
 * dosya kurmadan test edilir.
 */

import { readdir, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { CONFIG_DEFAULTS } from '../core/config.js';
import { AUDIO_EXTENSIONS, isImagePath, listFiles, matchOrder } from '../core/files.js';
import { probe } from '../core/probe.js';
import { mapWithLimit, probeCached } from '../core/probe-cache.js';
import { normalizeShortsPlan } from '../core/shorts-plan.js';
import { readJsonFile } from '../core/workspace.js';

/** Sıralı modda "bu oturumda atla" denebilen adımlar — kanıt gerektirmeyen elle işler. */
export const SKIPPABLE_STEPS = ['faz3'];

/**
 * Proje klasörünün anlık durumu. Eksik klasörler hata değil, "boş" sayılır.
 *
 * @param {string} dir proje klasörü
 */
export async function inspectProject(dir) {
  const projectPath = join(dir, 'project.json');
  const projectJson = await readProjectJson(projectPath);
  const data = projectJson.data ?? {};
  const at = (p) => (isAbsolute(p) ? p : resolve(dir, p));

  const clipValue = typeof data.clip === 'string' ? data.clip.trim() : '';
  const clipPath = clipValue ? at(clipValue) : null;
  const clipExists = clipPath ? await isFile(clipPath) : false;

  // Görsel kaynağı (core/config.js VIDEO_SOURCES). Tek resim modunda klip
  // adayları resimler\ altındaki BÜTÜN görseller: belirli bir dosya adı
  // (eski MASTER.png / Master1.jpg kuralı) aranmıyor — kullanıcı klasöre ne
  // koyduysa seçilebilir. Seçim, web listesi ve küçük resim aynı listeden.
  const videoSource = data.video?.source === 'image' ? 'image' : 'clip';
  const imageCandidates = (await fileNames(join(dir, 'resimler')))
    .filter((name) => isImagePath(name))
    .sort((a, b) => a.localeCompare(b, 'tr'))
    .map((name) => join(dir, 'resimler', name));
  // İki modun aday listesi de ölçülür: kullanıcı sonradan mod değiştirebiliyor
  // (prep/project-file.js setVideoSource) ve "öbür tarafta kaç aday var"
  // bilgisi olmadan bu seçim körlemesine olurdu.
  const clipCandidates = await filesOrEmpty(join(dir, 'videolar'), ['.mp4']);
  const clips = videoSource === 'image' ? imageCandidates : clipCandidates;

  // Pomodoro mola görüntüsü: çalışma görüntüsünden bağımsız, İKİ klasörden de
  // seçilebilir (resim ya da döngü videosu) — tür uzantıdan türer. Yollar proje
  // klasörüne göreli ("videolar/mola.mp4"), project.json'daki `breakClip` ile aynı biçim.
  const visualFiles = [...clipCandidates, ...imageCandidates];
  const breakCandidates = visualFiles.map((path) => relative(dir, path).split(sep).join('/'));
  const breakClipValue = typeof data.pomodoro?.breakClip === 'string' ? data.pomodoro.breakClip.trim() : '';
  const breakClipPath = breakClipValue ? at(breakClipValue) : null;

  // Proje türü: 'shorts' alt projesi kendi ekranını ve adımlarını kullanır
  // (kaynak videoyu KOPYALAMAZ, ana projedeki dosyaya yol tutar); 'video'
  // bugünkü montaj projesidir. Bilinmeyen değer 'video' sayılır — eski
  // projelerde alan hiç yok.
  const kind = data.kind === 'shorts' ? 'shorts' : 'video';

  const audioDir = at(nonEmpty(data.audioDir) ?? './audio');
  const output = data.output !== null && typeof data.output === 'object' ? data.output : {};
  const outputDir = at(nonEmpty(output.dir) ?? CONFIG_DEFAULTS.output.dir);
  const outputPath = resolve(outputDir, nonEmpty(output.name) ?? CONFIG_DEFAULTS.output.name);
  const tracklistPath = resolve(outputDir, nonEmpty(output.tracklist) ?? CONFIG_DEFAULTS.output.tracklist);

  const shorts = kind === 'shorts' ? await inspectShorts({ data, at, outputDir }) : null;

  return {
    name: dir.split(/[\\/]/).pop(),
    dir,
    projectPath,
    projectJson,
    kind,
    /** Yalnızca `kind: 'shorts'` projelerde dolu (yoksa null). */
    shorts,
    parentId: typeof data.parentId === 'string' && data.parentId.trim() ? data.parentId.trim() : null,
    /** Müzik stili (styles/<ad>), seçilmediyse null. */
    style: nonEmpty(data.style) ?? null,
    videoSource,
    clips,
    /** Mod değiştirme ekranı için: her modun aday sayısı ve klasörü. */
    videoSourceCandidates: {
      clip: { count: clipCandidates.length, dir: join(dir, 'videolar') },
      image: { count: imageCandidates.length, dir: join(dir, 'resimler') },
    },
    clip: { value: clipValue, path: clipPath, exists: clipExists },
    /** Pomodoro mola görüntüsünün seçilebilecek dosyaları (proje klasörüne göreli). */
    breakCandidates,
    /** Aynı dosyaların tam yolları — küçük resim/önizleme olarak sunulur (`assets/visual/<ad>`). */
    visualFiles,
    /** project.json → pomodoro.breakClip; yoksa value boş (mola = çalışma görüntüsü). */
    breakClip: {
      value: breakClipValue,
      exists: breakClipPath ? await isFile(breakClipPath) : false,
    },
    // Proje listesindeki küçük resim — kullanıcı seçmez: videoda görünen
    // görsel, yoksa resimler\ altındaki ilk görsel.
    thumbnail: (clipExists && isImagePath(clipPath) ? clipPath : null)
      ?? imageCandidates[0] ?? null,
    audioDir,
    audioCount: (await filesOrEmpty(audioDir, AUDIO_EXTENSIONS)).length,
    output: {
      path: outputPath,
      exists: await isFile(outputPath),
      tracklistPath,
      tracklistExists: await isFile(tracklistPath),
    },
  };
}

/**
 * Sıradaki adım. Kanıta göre SONDAN BAŞA bakılır: çıktı varsa bitti, klip ve
 * müzik varsa montaj… Böylece elle yapılmış ama "işaretlenmemiş" adımlar
 * yeniden istenmez.
 *
 * @param {Awaited<ReturnType<typeof inspectProject>>} s
 * @param {{ skipped?: Set<string> }} [options] bu oturumda atlanan elle adımlar
 * @returns {{ id: string, kind: 'manual'|'auto'|'done', title: string, detail: string, skippable: boolean }}
 */
export function nextStep(s, { skipped = new Set() } = {}) {
  const step = (id, kind, title, detail) => ({ id, kind, title, detail, skippable: SKIPPABLE_STEPS.includes(id) });

  if (s.kind === 'shorts') return shortsStep(s, step);

  if (!s.projectJson.ok) {
    return step('fix-project', 'manual', 'project.json düzeltilmeli', `${s.projectPath}: ${s.projectJson.error}`);
  }
  if (s.output.exists) {
    return step('done', 'done', 'Video hazır', `Çıktı: ${s.output.path}`);
  }

  const missingClip = s.clip.value && !s.clip.exists ? `clip'teki dosya bulunamadı: ${s.clip.path}\n` : '';

  const isStill = s.videoSource === 'image';

  // 10 Adımlı Akış: 6. Adım Video (Klip), 7. Adım Müzik'ten önce gelir!
  if (s.clips.length > 0 && !s.clip.exists) {
    return isStill
      ? step('clip', 'auto', 'Görseli seç', `${missingClip}resimler\\ altında ${s.clips.length} görsel var — video boyunca gösterilecek olanı seç.`)
      : step('clip', 'auto', 'Klibi seç', `${missingClip}videolar\\ altında ${s.clips.length} klip var — kullanılacak olanı seç.`);
  }

  // Tek resim: klip üretimi yok, video seçilen görselden üretilir.
  if (isStill && !s.clip.exists) {
    return step('clip', 'manual', 'Görsel bekleniyor', `${missingClip}Tek resim modu: resimler\\ altına bir görsel koy: ${join(s.dir, 'resimler')}`);
  }

  if (!s.clip.exists && !skipped.has('faz3')) {
    return step('faz3', 'manual', 'Klip',
      `${missingClip}Ürettiğin döngü klibini videolar\\ altına .mp4 olarak koy: ${join(s.dir, 'videolar')}`);
  }

  if (!s.clip.exists) {
    return step('clip', 'manual', 'Klip bekleniyor', `${missingClip}videolar\\ altına klibi (.mp4) koy: ${join(s.dir, 'videolar')}`);
  }

  const musicCompleted = isMusicCompleted(s);

  if (!musicCompleted) {
    return step('audio', 'manual', 'Müzik',
      `Müzik parçalarını şu klasöre koy: ${s.audioDir}\n` +
      'Sıra için project.json\'a "order" eklenebilir; yoksa alfabetik sıralanır.');
  }

  if (s.clip.exists && musicCompleted) {
    return step('build', 'auto', 'Montaj', `Klip: ${s.clip.value} · ${s.audioCount} parça\nÇıktı: ${s.output.path}`);
  }

  return step('clip', 'manual', 'Klip bekleniyor', `${missingClip}videolar\\ altına klibi (.mp4) koy: ${join(s.dir, 'videolar')}`);
}

/**
 * Canonical kullanıcı akışı — 8 adım, sırası sabit. Her adımın "tamam"
 * olması yalnızca diskteki kanıttan (dosyalar + project.json) hesaplanır;
 * UI'nin son tıklanan durumu kullanılmaz. `current` ilk tamamlanmamış adım,
 * hepsi tamamsa `publish`.
 *
 * Eski projelerde kaydı olmayan adımlar sonraki adımın kanıtından çıkarılır:
 * klip varsa açı kararı, çıktı varsa her şey.
 */
export const WORKFLOW_STEPS = [
  { id: 'project', title: 'Proje başlat', kind: 'manual', optional: false },
  { id: 'video', title: 'Video', kind: 'manual', optional: false },
  { id: 'music', title: 'Müzik', kind: 'manual', optional: false },
  { id: 'order', title: 'Sıralama', kind: 'manual', optional: false },
  { id: 'build', title: 'Montaj', kind: 'auto', optional: false },
  { id: 'publish', title: 'Yayın', kind: 'done', optional: false },
];

/**
 * @param {Awaited<ReturnType<typeof inspectProject>>} s
 * @returns {{ current: string, currentTitle: string, steps: Array<typeof WORKFLOW_STEPS[number] & { number: number, status: 'done'|'current'|'pending', skipped: boolean }> }}
 */
export function canonicalWorkflow(s) {
  const data = s.projectJson.data ?? {};
  const built = s.output.exists;
  const cropBottom = data.video?.cropBottom;
  const hasOrder = Array.isArray(data.order) && data.order.length > 0;
  const isStill = s.videoSource === 'image';
  const cropReady = (Number.isSafeInteger(cropBottom) && cropBottom >= 0) || isStill;

  const done = {
    project: s.projectJson.ok,
    video: (s.clip.exists && cropReady) || built,
    music: isMusicCompleted(s) || built,
    order: hasOrder || built,
    build: built,
    publish: built,
  };

  const firstOpen = WORKFLOW_STEPS.find((step) => step.id !== 'publish' && !done[step.id]);
  const current = firstOpen?.id ?? 'publish';
  return {
    current,
    currentTitle: WORKFLOW_STEPS.find((step) => step.id === current).title,
    steps: WORKFLOW_STEPS.map((step, index) => ({
      ...step,
      number: index + 1,
      status: step.id === current ? 'current' : done[step.id] ? 'done' : 'pending',
      skipped: false,
    })),
  };
}

// ------------------------------------------------------------------- Shorts

/**
 * Shorts alt projesinin durumu: kaynak video + kesitler + render edilmiş
 * çıktılar. Kaynak KOPYALANMADIĞI için burada yalnızca "yol duruyor mu"
 * sorusu yanıtlanır — dosya ana projede yaşamaya devam eder.
 *
 * @param {{ data: object, at: (p: string) => string, outputDir: string }} input
 */
async function inspectShorts({ data, at, outputDir }) {
  const plan = normalizeShortsPlan(data.shorts);
  const sourcePath = plan.source ? at(plan.source) : null;
  const dir = resolve(outputDir, 'shorts');

  const clips = [];
  for (const clip of plan.clips) {
    const path = resolve(dir, clip.output);
    const info = await stat(path).catch(() => null);
    clips.push({
      ...clip,
      outputPath: path,
      outputExists: info?.isFile() === true,
      outputSize: info?.isFile() ? info.size : null,
    });
  }

  return {
    source: {
      value: plan.source,
      path: sourcePath,
      exists: sourcePath ? await isFile(sourcePath) : false,
    },
    dir,
    clips,
    renderedCount: clips.filter((clip) => clip.outputExists).length,
    problems: plan.problems,
    warnings: plan.warnings,
  };
}

/** Shorts alt projesinin sıradaki adımı (`nextStep`'in shorts dalı). */
function shortsStep(s, step) {
  if (!s.projectJson.ok) {
    return step('fix-project', 'manual', 'project.json düzeltilmeli', `${s.projectPath}: ${s.projectJson.error}`);
  }
  const shorts = s.shorts ?? { source: { exists: false }, clips: [], renderedCount: 0 };
  if (!shorts.source.exists) {
    return step('shorts-source', 'manual', 'Kaynak video bekleniyor',
      shorts.source.value
        ? `shorts.source bulunamadı: ${shorts.source.path}`
        : 'Ana projedeki videoyu kaynak olarak seç.');
  }
  if (shorts.clips.length === 0) {
    return step('shorts-clips', 'manual', 'Shorts kesiti seç',
      "Timeline'dan aralığı seç, 9:16 kadrajı ayarla ve \"Bu Aralığı Al\" de.");
  }
  if (shorts.renderedCount < shorts.clips.length) {
    return step('shorts-export', 'auto', 'Shorts render',
      `${shorts.clips.length} kesit var, ${shorts.renderedCount} tanesi render edildi.`);
  }
  return step('done', 'done', 'Shorts hazır', `${shorts.renderedCount} kesit: ${shorts.dir}`);
}

/**
 * Shorts alt projesinin 3 adımı. Canonical akışın (6 adım) yerine geçer:
 * shorts projesinde müzik/sıralama/montaj yok.
 */
export const SHORTS_WORKFLOW_STEPS = [
  { id: 'source', title: 'Kaynak video', kind: 'manual', optional: false },
  { id: 'clips', title: 'Kesitler', kind: 'manual', optional: false },
  { id: 'export', title: 'Render', kind: 'auto', optional: false },
];

/**
 * @param {Awaited<ReturnType<typeof inspectProject>>} s
 * @returns {{ current: string, currentTitle: string, steps: object[] }}
 */
export function shortsWorkflow(s) {
  const shorts = s.shorts ?? { source: { exists: false }, clips: [], renderedCount: 0 };
  const done = {
    source: shorts.source.exists,
    clips: shorts.clips.length > 0,
    export: shorts.clips.length > 0 && shorts.renderedCount === shorts.clips.length,
  };
  const firstOpen = SHORTS_WORKFLOW_STEPS.find((step) => !done[step.id]);
  const current = firstOpen?.id ?? 'export';
  return {
    current,
    currentTitle: SHORTS_WORKFLOW_STEPS.find((step) => step.id === current).title,
    steps: SHORTS_WORKFLOW_STEPS.map((step, index) => ({
      ...step,
      number: index + 1,
      status: step.id === current ? 'current' : done[step.id] ? 'done' : 'pending',
      skipped: false,
    })),
  };
}

/**
 * Projenin türüne göre doğru akış. Web ve proje listesi bunu çağırır ki
 * shorts alt projesi "2/6 · Video" gibi kendisine ait olmayan bir adım
 * göstermesin.
 *
 * @param {Awaited<ReturnType<typeof inspectProject>>} s
 */
export function projectWorkflow(s) {
  return s.kind === 'shorts' ? shortsWorkflow(s) : canonicalWorkflow(s);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Müzik klasöründeki parçaların eklenme sırası (8. adım "Eklediğim sıra").
 * Kayıtlı olanlar (`workflow.audioAdded`) kayıt sırasıyla önce; kaydı olmayanlar
 * (ör. Explorer'dan elle konanlar) sonra, oluşturulma zamanına ve ada göre.
 *
 * @param {Awaited<ReturnType<typeof inspectProject>>} s
 * @returns {Promise<string[]>} dosya adları
 */
export async function audioAddedOrder(s) {
  const paths = await filesOrEmpty(s.audioDir, AUDIO_EXTENSIONS);
  const workflow = s.projectJson.data?.workflow;
  const recorded = Array.isArray(workflow?.audioAdded) ? workflow.audioAdded : [];
  const names = paths.map((path) => basename(path));

  const known = recorded.filter((name, i) => names.includes(name) && recorded.indexOf(name) === i);
  const rest = [];
  for (const [i, name] of names.entries()) {
    if (known.includes(name)) continue;
    const info = await stat(paths[i]).catch(() => null);
    rest.push({ name, time: info?.birthtimeMs ?? 0 });
  }
  // Aynı zamanda oluşanlar klasörün doğal sırasında kalır (sort kararlı).
  rest.sort((a, b) => a.time - b.time);
  return [...known, ...rest.map((item) => item.name)];
}

/**
 * Müzik parçaları, BUILD'in çalacağı sırayla ve ölçülmüş süreleriyle.
 *
 * Sıra kuralı `steps/02-audio-concat.js` ile aynı kaynaktan: `order` varsa
 * matchOrder, yoksa klasörün doğal sırası. Tek yerde duruyor çünkü hem web
 * (`server/project-api.js`) hem montaj adımı (`steps/02-audio-concat.js`) Pomodoro doğrulamasını
 * montajdan ÖNCE aynı sayılarla göstermek zorunda — iki ayrı kopya zamanla
 * birbirinden sapardı.
 *
 * Süreler ffprobe başlığından geliyor; build çözülen örnek sayısını kullanıyor
 * (dosya başına 13–27 ms fark). Build ayrıca aynı içerikli duplikeleri eliyor
 * (md5), burada elenmiyor — son sözü build içindeki doğrulama söyler.
 *
 * @param {Awaited<ReturnType<typeof inspectProject>>} s
 * @param {{ probeFn?: typeof probe }} [options]
 * @returns {Promise<{ path: string, file: string, duration: number|null }[]>}
 */
/** Aynı anda kaç ffprobe: disk ve CPU'yu boğmadan belirgin hızlanma. */
const PROBE_CONCURRENCY = 8;

export async function orderedAudioTracks(s, { probeFn = probe } = {}) {
  const paths = await filesOrEmpty(s.audioDir, AUDIO_EXTENSIONS);
  const order = s.projectJson.data?.order;
  const ordered = Array.isArray(order) && order.length > 0 ? matchOrder(order, paths).ordered : paths;

  // Sırayla ölçmek 99 parçalık projede 10 sn sürüyordu; sınırlı paralellik +
  // dosya kimliğine bağlı önbellek. Sonuç sırası girdiyle aynı kalır.
  return mapWithLimit(ordered, PROBE_CONCURRENCY, async (path) => {
    const info = await probeCached(path, probeFn).catch(() => null);
    return { path, file: basename(path), duration: info?.duration ?? null };
  });
}

/**
 * Müzik aşaması bitti mi? Parça planı varsa plan durumu (ya da tüm parçalar
 * tamam), yoksa audio klasöründe en az bir dosya. nextStep ile web API ortak
 * kullanır.
 *
 * @param {Awaited<ReturnType<typeof inspectProject>>} s
 * @returns {boolean}
 */
export function isMusicCompleted(s) {
  const musicData = s.projectJson.data?.music;
  const isMultiTrack = musicData && Array.isArray(musicData.tracks) && musicData.tracks.length > 0;
  return isMultiTrack
    ? (musicData.status === 'completed' || musicData.status === 'completed_by_user' || musicData.tracks.every((t) => t.status === 'completed'))
    : s.audioCount > 0;
}

/**
 * Videolar kökündeki projeler (içinde project.json olan klasörler), son
 * değiştirilen en üstte. Değişim zamanı: klasör ya da project.json, hangisi
 * yeniyse (dosya eklemek klasörü, clip yazmak project.json'u günceller).
 *
 * @param {string} videosDir
 * @returns {Promise<{ name: string, dir: string, mtimeMs: number, thumbnail: string|null, step: ReturnType<typeof nextStep> }[]>}
 */
export async function listProjects(videosDir) {
  let entries;
  try {
    entries = await readdir(videosDir, { withFileTypes: true });
  } catch (cause) {
    if (cause.code === 'ENOENT') return [];
    throw cause;
  }

  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(videosDir, entry.name);
    const projectInfo = await stat(join(dir, 'project.json')).catch(() => null);
    if (!projectInfo?.isFile()) continue;
    const dirInfo = await stat(dir);
    const status = await inspectProject(dir);
    projects.push({
      name: entry.name,
      dir,
      parentId: status.parentId,
      mtimeMs: Math.max(dirInfo.mtimeMs, projectInfo.mtimeMs),
      thumbnail: status.thumbnail,
      kind: status.kind,
      step: nextStep(status),
      workflow: projectWorkflow(status),
    });
  }
  return projects.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// ---------------------------------------------------------------- yardımcılar

/** Yarım yazılmış dosyayı tekrar okuma: deneme sayısı ve aralık (ms). */
const READ_ATTEMPTS = 4;
const READ_RETRY_MS = 25;

/**
 * project.json'u okur. Dosya o anda yazılıyorsa (writeFile önce boşaltır, sonra
 * doldurur) okuyan yarım/boş içerik görüp JSON hatası alabilir — ör. Shorts render
 * bitişinde `project.json` güncellenirken arayüzün 1,5 sn'lik yoklaması. Bu yüzden
 * JSON hatasında birkaç kez kısa aralıkla yeniden okunur; gerçekten bozuk dosya
 * yine hata verir (yalnızca ~75 ms gecikmeyle).
 */
async function readProjectJson(path) {
  let last = null;
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    try {
      const data = await readJsonFile(path);
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        return { ok: false, data: null, error: 'kök bir nesne olmalı' };
      }
      return { ok: true, data, error: null };
    } catch (cause) {
      last = cause;
      if (!(cause instanceof SyntaxError)) break;
      await new Promise((resolve) => setTimeout(resolve, READ_RETRY_MS));
    }
  }
  const error = last.code === 'ENOENT'
    ? 'dosya yok'
    : last instanceof SyntaxError ? `JSON ayrıştırılamadı: ${last.message}` : `okunamadı: ${last.code ?? last.message}`;
  return { ok: false, data: null, error };
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

async function fileNames(dir) {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  } catch (cause) {
    if (cause.code === 'ENOENT') return [];
    throw cause;
  }
}

async function filesOrEmpty(dir, extensions) {
  try {
    return await listFiles(dir, extensions);
  } catch (cause) {
    if (cause.code === 'ENOENT') return [];
    throw cause;
  }
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
