/**
 * Zip okuyucu — yalnızca Node'un kendi `zlib`'i, dış bağımlılık yok.
 *
 * Tek sorumluluk: bir .zip dosyasının içindekileri listelemek ve TEK bir girdiyi
 * diske akıtarak açmak. Hangi girdinin açılacağı, nereye yazılacağı ve adların
 * temizlenmesi çağıranın işi (`prep/audio-zip.js`).
 *
 * Neden elle: müzik zip'leri yüzlerce MB olabiliyor; dosyayı belleğe almadan
 * merkezi dizinden okuyup girdileri tek tek akıtmak gerekiyor.
 *
 * Desteklenen: "stored" (0) ve "deflate" (8) — Windows Gezgini, 7-Zip, macOS
 * ve çoğu müzik sitesinin ürettiği zip'ler bunlar. Her açılan girdinin CRC32'si
 * ve boyutu başlıktakiyle karşılaştırılır; yarım/bozuk dosya sessizce kalmaz.
 * Desteklenmeyenler (şifreli, zip64 / 4 GB üstü, bzip2/lzma) anlaşılır
 * `ZipError` ile reddedilir.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createInflateRaw, crc32 } from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** Sonundaki açıklama (en çok 65535 bayt) + 22 baytlık başlık. */
const EOCD_SEARCH_BYTES = 65535 + 22;

/** Bir zip'te beklenen en çok girdi: bunun ötesi büyük ihtimalle bozuk/kötü niyetli. */
const MAX_ENTRIES = 10000;

export class ZipError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}

/**
 * @typedef {object} ZipEntry
 * @property {string} name zip içindeki yol (ayırıcı olduğu gibi)
 * @property {boolean} isDirectory
 * @property {number} method 0 = stored, 8 = deflate
 * @property {number} compressedSize
 * @property {number} size açılmış boyut
 * @property {number} crc32
 * @property {number} offset yerel başlığın dosyadaki konumu
 * @property {boolean} encrypted
 */

/**
 * Merkezi dizini okur.
 *
 * @param {string} zipPath
 * @returns {Promise<ZipEntry[]>}
 */
export async function listZipEntries(zipPath) {
  const { size } = await stat(zipPath);
  if (size < 22) throw new ZipError('Dosya bir zip değil (çok küçük).');

  const handle = await open(zipPath, 'r');
  try {
    const tailLength = Math.min(size, EOCD_SEARCH_BYTES);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);

    let eocd = -1;
    for (let i = tailLength - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd === -1) throw new ZipError('Dosya bir zip değil ya da bozuk (dizin sonu bulunamadı).');

    const total = tail.readUInt16LE(eocd + 10);
    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    if (total === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      throw new ZipError('4 GB üstü (zip64) arşivler desteklenmiyor — parçaları ayrı zip yap ya da klasöre aç.');
    }
    if (total > MAX_ENTRIES) throw new ZipError(`Zip çok fazla dosya içeriyor (${total}).`);
    if (directoryOffset + directorySize > size) throw new ZipError('Zip bozuk (dizin dosya dışında).');

    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directorySize, directoryOffset);

    const entries = [];
    let pos = 0;
    for (let i = 0; i < total; i++) {
      if (pos + 46 > directory.length || directory.readUInt32LE(pos) !== SIG_CENTRAL) {
        throw new ZipError('Zip bozuk (dizin kaydı okunamadı).');
      }
      const flags = directory.readUInt16LE(pos + 8);
      const nameLength = directory.readUInt16LE(pos + 28);
      const extraLength = directory.readUInt16LE(pos + 30);
      const commentLength = directory.readUInt16LE(pos + 32);
      const compressedSize = directory.readUInt32LE(pos + 20);
      const uncompressedSize = directory.readUInt32LE(pos + 24);
      const offset = directory.readUInt32LE(pos + 42);
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || offset === 0xffffffff) {
        throw new ZipError('4 GB üstü (zip64) dosya içeriyor — desteklenmiyor.');
      }

      const rawName = directory.subarray(pos + 46, pos + 46 + nameLength);
      const name = decodeName(rawName, (flags & 0x800) !== 0);
      entries.push({
        name,
        isDirectory: name.endsWith('/') || name.endsWith('\\'),
        method: directory.readUInt16LE(pos + 10),
        compressedSize,
        size: uncompressedSize,
        crc32: directory.readUInt32LE(pos + 16),
        offset,
        encrypted: (flags & 0x1) !== 0,
      });
      pos += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

/**
 * Tek bir girdiyi `destPath`'e akıtır. Boyut ve CRC32 uyuşmazsa hata atar
 * (yarım dosyayı silmek çağıranın işi).
 *
 * @param {string} zipPath
 * @param {ZipEntry} entry
 * @param {string} destPath
 */
export async function extractZipEntry(zipPath, entry, destPath) {
  if (entry.isDirectory) throw new ZipError(`Klasör açılamaz: ${entry.name}`);
  if (entry.encrypted) throw new ZipError(`Şifreli dosya desteklenmiyor: ${entry.name}`);
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ZipError(`Desteklenmeyen sıkıştırma yöntemi (${entry.method}): ${entry.name}`);
  }

  // Yerel başlığın ad/ek alan uzunlukları merkezi dizindekinden farklı olabilir: gerçek veri başlangıcı buradan.
  const handle = await open(zipPath, 'r');
  let dataStart;
  try {
    const header = Buffer.alloc(30);
    const { bytesRead } = await handle.read(header, 0, 30, entry.offset);
    if (bytesRead < 30 || header.readUInt32LE(0) !== SIG_LOCAL) {
      throw new ZipError(`Zip bozuk (dosya başlığı okunamadı): ${entry.name}`);
    }
    dataStart = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  } finally {
    await handle.close();
  }

  let written = 0;
  let checksum = 0;
  const verify = new Transform({
    transform(chunk, _encoding, callback) {
      written += chunk.length;
      // Başlıktaki boyuta güvenme: yalan söyleyen bir zip diski doldurmasın.
      if (written > entry.size) {
        callback(new ZipError(`Dosya başlıkta yazılandan büyük (zip bozuk ya da kötü niyetli): ${entry.name}`));
        return;
      }
      checksum = crc32(chunk, checksum);
      callback(null, chunk);
    },
  });

  // Boş dosya: akıtılacak veri yok (createReadStream bitişi başlangıçtan küçük aralığı kabul etmez).
  if (entry.compressedSize === 0) {
    if (entry.size !== 0) throw new ZipError(`Zip bozuk (boş veri, boyut ${entry.size}): ${entry.name}`);
    await writeFile(destPath, '');
    return;
  }

  const source = createReadStream(zipPath, { start: dataStart, end: dataStart + entry.compressedSize - 1 });
  const stages = entry.method === 8 ? [source, createInflateRaw(), verify] : [source, verify];
  await pipeline(...stages, createWriteStream(destPath));

  if (written !== entry.size) {
    throw new ZipError(`Dosya eksik açıldı (${written}/${entry.size} bayt): ${entry.name}`);
  }
  if ((checksum >>> 0) !== entry.crc32) {
    throw new ZipError(`Dosya bozuk (CRC uyuşmuyor): ${entry.name}`);
  }
}

/** Zip adı: UTF-8 bayrağı varsa UTF-8; yoksa önce UTF-8 dene, olmazsa latin1 (eski Windows zip'leri). */
function decodeName(bytes, utf8Flag) {
  if (utf8Flag) return bytes.toString('utf8');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return bytes.toString('latin1');
  }
}
