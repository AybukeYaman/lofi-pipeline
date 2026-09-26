/**
 * core/trash.js — Geri Dönüşüm Kutusu adapter'ı, sahte PowerShell süreciyle.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';

import { TrashError, moveDirToTrash } from '../../core/trash.js';

/** Sahte süreç: verilen kodla kapanır, isteğe bağlı stderr yazar. */
function fakeSpawn({ code = 0, stderr = '' } = {}) {
  const calls = [];
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    setImmediate(() => {
      if (stderr) child.stderr.write(stderr);
      child.emit('close', code);
    });
    return child;
  };
  return { spawnFn, calls };
}

describe('moveDirToTrash', () => {
  test('yol komuta gömülmez, ortam değişkeniyle geçer; SendToRecycleBin', async () => {
    const { spawnFn, calls } = fakeSpawn();
    const dir = "C:\\videolar\\a'; Remove-Item C:\\ -Recurse #";
    await moveDirToTrash(dir, { spawnFn, platform: 'win32' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'powershell.exe');
    const script = calls[0].args.at(-1);
    assert.match(script, /SendToRecycleBin/);
    assert.ok(!script.includes(dir), 'yol betikte yok');
    assert.equal(calls[0].options.env.LOFI_TRASH_PATH, dir);
  });

  test('sıfır olmayan çıkış → TrashError, stderr mesajda', async () => {
    const { spawnFn } = fakeSpawn({ code: 1, stderr: 'erişim reddedildi' });
    await assert.rejects(moveDirToTrash('C:\\x', { spawnFn, platform: 'win32' }), (e) =>
      e instanceof TrashError && /erişim reddedildi/.test(e.message) && e.path === 'C:\\x');
  });

  test('Windows dışında hiç süreç başlatmaz', async () => {
    const { spawnFn, calls } = fakeSpawn();
    await assert.rejects(moveDirToTrash('/x', { spawnFn, platform: 'linux' }), TrashError);
    assert.equal(calls.length, 0);
  });
});
