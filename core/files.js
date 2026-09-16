/**
 * Dosya sistemi yardımcıları — tarama, doğal sıralama, hash, isim eşleştirme.
 *
 * Tek sorumluluk: diskteki dosyaları isimleriyle ve içerikleriyle tanımak.
 * Medya içeriği hakkında hiçbir şey bilmez (onu core/probe.js ölçer),
 * ffmpeg çalıştırmaz.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, extname, join, sep } from 'node:path';

/** Varsayılan ses uzantıları. Uzantı yalnızca ön eleme içindir — */
/** gerçek codec kararı her zaman probe() ölçümüne dayanır (gizli Opus tuzağı). */
export const AUDIO_EXTENSIONS = ['.m4a', '.mp3', '.wav', '.flac', '.aac', '.opus', '.ogg'];

/**
 * concat demuxer liste satırı: `file '<yol>'`
 *
 * Ayıraçlar ileri eğik çizgiye çevrilir (demuxer ters eğik çizgiyi kaçış
 * karakteri sanabiliyor), tek tırnak kabuk kuralıyla kaçırılır.
 * Video birleştirmesi (Aşama 4, gövde kopyası) kullanır. Ses artık concat
 * filtresiyle birleştiriliyor (Aşama 6 P4) — demuxer priming'i atmıyordu.
 *
 * @param {string} path
 * @returns {string}
 */
export function concatLine(path) {
  const normalized = path.split(sep).join('/');
  const escaped = normalized.split("'").join("'\\''");
  return `file '${escaped}'`;
}

/**
 * Doğal (insan) sıralama: "2" < "10", alfabetikte tersi olurdu.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function naturalCompare(a, b) {
  return a.localeCompare(b, 'tr', { numeric: true, sensitivity: 'base' });
}

/**
 * Bir klasördeki dosyaları uzantıya göre filtreleyip doğal sırada döndürür.
 * Alt klasörlere inmez.
 *
 * @param {string} dir
 * @param {string[]} [extensions]
 * @returns {Promise<string[]>} tam yollar
 */
export async function listFiles(dir, extensions = AUDIO_EXTENSIONS) {
  const allowed = new Set(extensions.map((e) => e.toLowerCase()));
  const entries = await readdir(dir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && allowed.has(extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort(naturalCompare)
    .map((name) => join(dir, name));
}

/**
 * Klasörde çakışmayan dosya adı: "Ad.mp3" varsa "Ad (1).mp3", "Ad (2).mp3"...
 * @param {string} dir
 * @param {string} name
 * @returns {Promise<string>}
 */
export async function uniqueFileName(dir, name) {
  const ext = extname(name);
  const base = basename(name, ext);
  let candidate = name;
  for (let counter = 1; await stat(join(dir, candidate)).then(() => true, () => false); counter++) {
    candidate = `${base} (${counter})${ext}`;
  }
  return candidate;
}

/**
 * Dosyanın MD5 özeti. Akış kullanır, dosyayı belleğe almaz.
 * @param {string} path
 * @returns {Promise<string>}
 */
export function md5File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Aynı içeriğe sahip dosyaları gruplar.
 * İlk görülen (doğal sırada en baştaki) korunur, kalanlar duplike sayılır.
 *
 * Dosyaları SİLMEZ — sadece raporlar. Silme kararı kullanıcınındır.
 *
 * @param {string[]} paths
 * @returns {Promise<{ unique: string[], duplicates: Array<{ path: string, sameAs: string, md5: string }> }>}
 */
export async function findDuplicates(paths) {
  const seen = new Map();
  const unique = [];
  const duplicates = [];

  for (const path of paths) {
    const md5 = await md5File(path);
    const original = seen.get(md5);
    if (original === undefined) {
      seen.set(md5, path);
      unique.push(path);
    } else {
      duplicates.push({ path, sameAs: original, md5 });
    }
  }

  return { unique, duplicates };
}

/**
 * Dosya adını eşleştirme anahtarına indirger.
 *
 * Kullanıcı order.txt'ye sade ad yazsın diye:
 *   "midnight-window [usesuno.com].m4a" → "midnight window"
 *   "Midnight_Window (1).mp3"           → "midnight window"
 *   "midnight window"                   → "midnight window"
 *
 * Atılanlar: uzantı, köşeli/normal parantez içindeki ekler, noktalama.
 *
 * @param {string} name dosya adı veya order.txt satırı
 * @returns {string}
 */
export function normalizeName(name) {
  return name
    .replace(/\.[a-z0-9]{1,5}$/i, '')      // uzantı
    .replace(/\[[^\]]*\]/g, ' ')            // [usesuno.com]
    .replace(/\([^)]*\)/g, ' ')             // (1)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')       // noktalama → boşluk
    .trim();
}

/**
 * order.txt satırlarını diskteki dosyalarla eşleştirir.
 *
 * Eşleşme normalize edilmiş ada göre yapılır, tam dosya adı gerekmez.
 * Hiçbir şey sessizce düşmez: eşleşmeyen satır, birden fazla dosyaya uyan
 * satır ve order.txt'de hiç geçmeyen dosya ayrı ayrı raporlanır.
 * Listede olmayan dosyalar sona eklenir — parça sessizce kaybolmasın.
 *
 * @param {string[]} lines order.txt satırları (ham)
 * @param {string[]} paths tam dosya yolları
 * @returns {{
 *   ordered: string[],
 *   unmatchedLines: Array<{ line: string, lineNumber: number }>,
 *   ambiguousLines: Array<{ line: string, lineNumber: number, candidates: string[] }>,
 *   unlistedFiles: string[],
 * }}
 */
export function matchOrder(lines, paths) {
  /** @type {Map<string, string[]>} normalize edilmiş ad → yollar */
  const index = new Map();
  for (const path of paths) {
    const key = normalizeName(basename(path));
    const bucket = index.get(key);
    if (bucket) bucket.push(path);
    else index.set(key, [path]);
  }

  const ordered = [];
  const used = new Set();
  const unmatchedLines = [];
  const ambiguousLines = [];

  lines.forEach((raw, i) => {
    const lineNumber = i + 1;
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;   // boş satır ve yorum

    const key = normalizeName(line);
    const candidates = (index.get(key) ?? []).filter((p) => !used.has(p));

    if (candidates.length === 0) {
      unmatchedLines.push({ line, lineNumber });
      return;
    }
    if (candidates.length > 1) {
      ambiguousLines.push({ line, lineNumber, candidates });
      return;
    }

    ordered.push(candidates[0]);
    used.add(candidates[0]);
  });

  const unlistedFiles = paths.filter((p) => !used.has(p));

  return {
    ordered: [...ordered, ...unlistedFiles],
    unmatchedLines,
    ambiguousLines,
    unlistedFiles,
  };
}
