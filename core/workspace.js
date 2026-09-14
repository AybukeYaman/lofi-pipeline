/**
 * Geçici çalışma alanı — ara dosyaların ömrünü yönetir.
 *
 * Tek sorumluluk: klasör aç, içine güvenli biçimde dosya yaz, sonunda temizle.
 * Dosyaların ne olduğunu bilmez (list.txt mi mix.m4a mi umursamaz),
 * ffmpeg çalıştırmaz. BOM'a dayanıklı metin/JSON okuma-yazma da burada —
 * aynı tuzak (bölüm 8) hem build'in hem prep/'in dosyalarında var.
 *
 * Disk dar (≈65 GB boş) — temizlik bu projede isteğe bağlı değil.
 */

import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Geçici klasör adının ön eki. */
const PREFIX = 'lofi-build-';

/**
 * Metni BOM'suz, LF satır sonlu UTF-8 olarak yazar.
 *
 * BOM tuzağı: ffmpeg concat demuxer BOM'lu dosyada
 * `Line 1: unknown keyword '﻿file'` hatası veriyor. Node kendiliğinden BOM
 * yazmaz ama çağıran taraftan gelen BOM'u da burada kesiyoruz.
 * CRLF de temizleniyor — satır sonundaki \r yol adının parçası sayılıyor.
 *
 * @param {string} path
 * @param {string} content
 * @returns {Promise<string>} yazılan yol
 */
export async function writeTextFile(path, content) {
  await writeFile(path, Buffer.from(normalizeText(content), 'utf8'));
  return path;
}

/**
 * BOM'u keser, satır sonlarını LF yapar. Diskten okunan şablonlar da
 * bundan geçer: core.autocrlf=true ile checkout CRLF getiriyor.
 *
 * @param {string} content
 * @returns {string}
 */
export function normalizeText(content) {
  return content
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

/**
 * JSON dosyasını okur; baştaki BOM kesilir (PowerShell'in
 * Set-Content -Encoding UTF8'i BOM ekliyor, bölüm 8).
 *
 * Hatalar sarılmaz: okuma hatası `code` taşır (ENOENT…), bozuk JSON
 * `SyntaxError` fırlatır — mesajı çağıran taraf kendi bağlamıyla kurar.
 *
 * @param {string} path
 * @returns {Promise<unknown>}
 */
export async function readJsonFile(path) {
  return JSON.parse(normalizeText(await readFile(path, 'utf8')));
}

/**
 * Bir klasörün toplam boyutu (byte). Alt klasörlere iner.
 * Temizlikte ne kadar yer açıldığını raporlamak için.
 *
 * @param {string} dir
 * @returns {Promise<number>}
 */
export async function directorySize(dir) {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(path);
    } else if (entry.isFile()) {
      total += (await stat(path)).size;
    }
  }

  return total;
}

/**
 * Yeni bir çalışma alanı açar.
 *
 * Klasör `mkdtemp` ile benzersiz açılır; aynı anda iki build çalışsa bile
 * ara dosyalar birbirine karışmaz.
 *
 * @param {object} [options]
 * @param {string} [options.root] klasörün açılacağı kök (varsayılan: OS temp).
 *   Çıktıyla aynı sürücüyü vermek büyük ara dosyaların sürücüler arası
 *   kopyalanmasını önler.
 * @param {boolean} [options.keep] true ise cleanup() hiçbir şey silmez —
 *   hata ayıklarken ara dosyalara bakabilmek için.
 * @returns {Promise<{
 *   dir: string,
 *   keep: boolean,
 *   path: (name: string) => string,
 *   writeText: (name: string, content: string) => Promise<string>,
 *   size: () => Promise<number>,
 *   cleanup: () => Promise<{ removed: boolean, freedBytes: number }>,
 * }>}
 */
export async function createWorkspace(options = {}) {
  const { root = tmpdir(), keep = false } = options;
  const dir = await mkdtemp(join(root, PREFIX));

  /** @param {string} name */
  const path = (name) => join(dir, name);

  return {
    dir,
    keep,

    path,

    /** Ara dosyayı BOM'suz yazar, tam yolunu döndürür. */
    writeText: (name, content) => writeTextFile(path(name), content),

    /** Şu anda ara dosyaların kapladığı yer (byte). */
    size: () => directorySize(dir),

    /**
     * Çalışma alanını siler. `keep` verilmişse dokunmaz.
     * Temizlik başarısız olursa build'i düşürmez — sadece sonucu bildirir.
     */
    async cleanup() {
      if (keep) return { removed: false, freedBytes: await directorySize(dir) };

      const freedBytes = await directorySize(dir).catch(() => 0);
      await rm(dir, { recursive: true, force: true });
      return { removed: true, freedBytes };
    },
  };
}
