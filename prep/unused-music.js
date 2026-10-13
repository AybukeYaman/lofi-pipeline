/**
 * Pomodoro'da fazla müzik montajda kırpılınca HİÇ kullanılmayan parçaların
 * müzik klasöründen kaldırılması.
 *
 * Silmek yerine Geri Dönüşüm Kutusu'na taşınır (`core/trash.js`, proje silmeyle
 * aynı kural): kullanıcı yanlışlıkla fazla parça koyduysa geri alabilir. Yalnızca
 * tamamen dışarıda kalan parçalar gider; kısaltılan son parça kullanıldığı için
 * yerinde kalır. `project.json`'daki sıra ve "eklediğim sıra" kayıtlarından da
 * çıkarılır, yoksa bir sonraki montaj olmayan dosyayı arardı.
 *
 * Yalnızca montaj BAŞARIYLA bitince çağrılır (build.js): yarıda kalan bir
 * montaj müzik kaybettirmez.
 */

import { basename } from 'node:path';

import { moveFileToTrash } from '../core/trash.js';
import { forgetAudioFiles } from './project-file.js';

/**
 * @param {object} input
 * @param {{ tracks: Array<{ path: string, dropped: boolean }> }} input.trim `planTrim` çıktısı
 * @param {string} input.projectPath project.json yolu
 * @param {(path: string) => Promise<void>} [input.trashFile] testte sahte
 * @returns {Promise<{ moved: string[], failed: Array<{ file: string, error: string }> }>}
 */
export async function discardUnusedMusic({ trim, projectPath, trashFile = moveFileToTrash }) {
  const moved = [];
  const failed = [];

  for (const track of trim.tracks.filter((t) => t.dropped)) {
    try {
      await trashFile(track.path);
      moved.push(basename(track.path));
    } catch (error) {
      failed.push({ file: basename(track.path), error: error.message });
    }
  }

  await forgetAudioFiles(projectPath, moved);
  return { moved, failed };
}
