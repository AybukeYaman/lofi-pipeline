/**
 * Testler için küçük zip YAZICI — gerçek bir arşivleyiciye bağımlı olmadan,
 * okuyucunun (core/zip.js) bozuk/uç durumlarını da üretebilmek için.
 */

import { writeFile } from 'node:fs/promises';
import { crc32, deflateRawSync } from 'node:zlib';

/**
 * @param {string} path
 * @param {Array<{
 *   name: string, data?: Buffer|string, method?: 'deflate'|'store',
 *   encrypted?: boolean, badCrc?: boolean, utf8?: boolean,
 * }>} entries `name` "/" ile bitiyorsa klasör girdisi
 * @param {{ comment?: string }} [options]
 */
export async function makeZip(path, entries, { comment = '' } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const isDirectory = entry.name.endsWith('/');
    const raw = Buffer.from(entry.data ?? '');
    const method = isDirectory || entry.method === 'store' ? 0 : 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const checksum = (crc32(raw) ^ (entry.badCrc ? 1 : 0)) >>> 0;
    const name = Buffer.from(entry.name, 'utf8');
    // Bit 11: UTF-8 ad; yoksa eski Windows zip'leri gibi bayraksız.
    const flags = (entry.utf8 === false ? 0 : 0x800) | (entry.encrypted ? 0x1 : 0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const directory = Buffer.concat(centrals);
  const note = Buffer.from(comment);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(note.length, 20);

  await writeFile(path, Buffer.concat([...locals, directory, end, note]));
  return path;
}
