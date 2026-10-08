/**
 * project.json `shorts` bloğuna hedefli yazım — kesit ekle/güncelle/sil,
 * kaynak video ve render damgası.
 *
 * Tek sorumluluk: diskteki kaydı güncellemek. Kuralları bilmez (onlar
 * `core/shorts-plan.js`), ffmpeg çalıştırmaz (o `steps/08-shorts-export.js`).
 * `prep/project-file.js` ile aynı sözleşme: diğer anahtarlar korunur, dosya
 * 2 boşluk girintiyle BOM'suz yeniden yazılır.
 */

import { writeTextFile } from '../core/workspace.js';
import {
  clipOutputName,
  nextClipId,
  nextClipTitle,
  normalizeShortsClip,
  normalizeShortsPlan,
  serializeShortsPlan,
} from '../core/shorts-plan.js';
import { ProjectFileError, readProjectObject } from './project-file.js';

/**
 * Bloğu okur ve normalleştirir (yazım öncesi tek okuma noktası).
 *
 * @param {string} projectPath
 * @returns {Promise<{ json: object, plan: ReturnType<typeof normalizeShortsPlan> }>}
 */
async function readPlan(projectPath) {
  const json = await readProjectObject(projectPath);
  return { json, plan: normalizeShortsPlan(json.shorts) };
}

/** Normalleştirilmiş planı diske yazar; `shorts` dışındaki alanlara dokunmaz. */
async function writePlan(projectPath, json, plan) {
  json.shorts = serializeShortsPlan(plan);
  await writeTextFile(projectPath, JSON.stringify(json, null, 2) + '\n');
  return normalizeShortsPlan(json.shorts);
}

/**
 * Kaynak videoyu yazar (ana projedeki dosyanın yolu). Dosya KOPYALANMAZ,
 * yalnızca yol kaydedilir.
 *
 * @param {string} projectPath
 * @param {string} sourcePath
 */
export async function setShortsSource(projectPath, sourcePath) {
  if (typeof sourcePath !== 'string' || sourcePath.trim() === '') {
    throw new ProjectFileError('shorts.source boş olamaz');
  }
  const { json, plan } = await readPlan(projectPath);
  return writePlan(projectPath, json, { ...plan, source: sourcePath.trim() });
}

/**
 * Yeni kesit ekler ("Bu Aralığı Al"). Kimlik ve başlık verilmezse sıradaki
 * boş olanlar kullanılır.
 *
 * @param {string} projectPath
 * @param {{ start: number, end: number, title?: string, frame?: object }} input
 * @param {{ sourceDuration?: number|null }} [context]
 * @returns {Promise<{ plan: object, clip: object }>}
 */
export async function addShortsClip(projectPath, input, { sourceDuration = null } = {}) {
  const { json, plan } = await readPlan(projectPath);

  const id = nextClipId(plan.clips);
  const title = typeof input?.title === 'string' && input.title.trim() !== ''
    ? input.title.trim()
    : nextClipTitle(plan.clips);

  const { clip, problems } = normalizeShortsClip(
    { ...input, id, title, output: clipOutputName(id, title) },
    { index: plan.clips.length, sourceDuration },
  );
  if (!clip) throw new ProjectFileError(problems.join('; '));

  const nextPlan = await writePlan(projectPath, json, { ...plan, clips: [...plan.clips, clip] });
  return { plan: nextPlan, clip: nextPlan.clips.find((item) => item.id === clip.id) ?? clip };
}

/**
 * Var olan kesidin aralığını/kadrajını/başlığını değiştirir.
 *
 * Çıktı dosya adı DEĞİŞMEZ: render edilmiş dosya yeniden adlandırılmadan
 * yörüngede kalırsa iki ayrı dosya karışıyor. Başlık değişse de ad sabit.
 * Aralık ya da kadraj değiştiyse `renderedAt` silinir — ekrandaki "render
 * edildi" damgası artık geçersiz.
 *
 * @param {string} projectPath
 * @param {string} clipId
 * @param {{ start?: number, end?: number, title?: string, frame?: object }} patch
 * @param {{ sourceDuration?: number|null }} [context]
 */
export async function updateShortsClip(projectPath, clipId, patch, { sourceDuration = null } = {}) {
  const { json, plan } = await readPlan(projectPath);
  const index = plan.clips.findIndex((clip) => clip.id === clipId);
  if (index === -1) throw new ProjectFileError(`kesit bulunamadı: ${clipId}`);

  const current = plan.clips[index];
  const merged = {
    ...current,
    ...(patch?.title !== undefined ? { title: String(patch.title).trim() || current.title } : {}),
    ...(patch?.start !== undefined ? { start: patch.start } : {}),
    ...(patch?.end !== undefined ? { end: patch.end } : {}),
    frame: { ...current.frame, ...(patch?.frame ?? {}) },
  };

  const { clip, problems } = normalizeShortsClip(
    { ...merged, id: current.id, output: current.output },
    { index, sourceDuration },
  );
  if (!clip) throw new ProjectFileError(problems.join('; '));

  const changed = clip.start !== current.start
    || clip.end !== current.end
    || clip.frame.zoom !== current.frame.zoom
    || clip.frame.x !== current.frame.x
    || clip.frame.y !== current.frame.y;
  clip.renderedAt = changed ? null : current.renderedAt;

  const clips = [...plan.clips];
  clips[index] = clip;
  const nextPlan = await writePlan(projectPath, json, { ...plan, clips });
  return { plan: nextPlan, clip: nextPlan.clips.find((item) => item.id === clip.id) ?? clip };
}

/**
 * Kesidi kayıttan siler. Render edilmiş dosyaya DOKUNMAZ — dosya silme
 * kararı çağırana (API) ait.
 *
 * @param {string} projectPath
 * @param {string} clipId
 */
export async function removeShortsClip(projectPath, clipId) {
  const { json, plan } = await readPlan(projectPath);
  const clip = plan.clips.find((item) => item.id === clipId);
  if (!clip) throw new ProjectFileError(`kesit bulunamadı: ${clipId}`);

  const nextPlan = await writePlan(projectPath, json, {
    ...plan,
    clips: plan.clips.filter((item) => item.id !== clipId),
  });
  return { plan: nextPlan, removed: clip };
}

/**
 * Render başarılıysa damgayı yazar (`renderedAt`). Çıktının VARLIĞI yine
 * diskten okunuyor — damga yalnızca "ne zaman" bilgisi.
 *
 * @param {string} projectPath
 * @param {string} clipId
 * @param {{ at?: string }} [options]
 */
export async function markShortsClipRendered(projectPath, clipId, { at = new Date().toISOString() } = {}) {
  const { json, plan } = await readPlan(projectPath);
  const index = plan.clips.findIndex((clip) => clip.id === clipId);
  if (index === -1) throw new ProjectFileError(`kesit bulunamadı: ${clipId}`);

  const clips = [...plan.clips];
  clips[index] = { ...clips[index], renderedAt: at };
  return writePlan(projectPath, json, { ...plan, clips });
}
