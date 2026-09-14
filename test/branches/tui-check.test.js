/**
 * Aşama 10a — tui-check betiği ve IPC alt süreci (gerçek süreçler).
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { REPO_ROOT } from '../../ui/runner.js';

const CHILD = join(REPO_ROOT, 'scripts', 'tui-check-child.js');

function startChild(mode) {
  const child = spawn(process.execPath, [CHILD, mode], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const messages = [];
  let stdout = '';
  child.on('message', (m) => messages.push(m));
  child.stdout.on('data', (c) => { stdout += c; });
  const done = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  return { child, messages, done, stdout: () => stdout };
}

describe('tui-check', () => {
  test('stdio boruya bağlı → ortam bilgisi, kod 2, stack trace yok', async () => {
    const child = spawn(process.execPath, [join(REPO_ROOT, 'scripts', 'tui-check.js')], { cwd: REPO_ROOT, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdin.end();
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 2, stderr);
    assert.match(stdout, /stdin TTY: false · stdout TTY: false/);
    assert.match(stderr, /ink dashboard burada çalışamaz/);
    assert.doesNotMatch(stderr, /\n\s+at /);
  });

  test('alt süreç IPC\'siz başlatılırsa kod 2', async () => {
    const child = spawn(process.execPath, [CHILD], { cwd: REPO_ROOT, stdio: 'pipe' });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 2);
  });

  test('IPC: artan ilerleme mesajları, stdout satırları, done 0', async () => {
    const run = startChild('test');
    assert.equal(await run.done, 0);
    const progress = run.messages.filter((m) => m.type === 'progress');
    assert.ok(progress.length >= 3);
    assert.deepEqual([...new Set(progress.map((m) => m.tag))], ['02', '04', '03']);
    const fours = progress.filter((m) => m.tag === '04').map((m) => m.seconds);
    assert.deepEqual(fours, [...fours].sort((a, b) => a - b));
    assert.deepEqual(run.messages.at(-1), { type: 'done', code: 0 });
    assert.match(run.stdout(), /alt süreç başladı/);
  });

  test('IPC cancel → temizlik mesajları, done 130, çıkış kodu 130', async () => {
    const run = startChild('uzun');
    await new Promise((resolve) => run.child.once('message', resolve));
    run.child.send({ type: 'cancel' });
    assert.equal(await run.done, 130);
    const logs = run.messages.filter((m) => m.type === 'log').map((m) => m.message);
    assert.deepEqual(logs, ['iptal alındı — temizlik yapılıyor', 'temizlik bitti']);
    assert.deepEqual(run.messages.at(-1), { type: 'done', code: 130 });
  });
});
