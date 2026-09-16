/**
 * ui/runner.js — CLI'ları ayrı süreçte çalıştırma (gerçek alt süreç + sahte spawn).
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { REPO_ROOT, isParentAlive, runScript } from '../../ui/runner.js';

describe('runScript', () => {
  test('gerçek alt süreç: --help → 0, bilinmeyen bayrak → 2', async () => {
    assert.equal(await runScript('new-video.js', ['--help']), 0);
    assert.equal(await runScript('new-video.js', ['--bilinmeyen']), 2);
  });

  test('node ile, betik repo kökünden, cwd repo kökü, terminal devredilir', async () => {
    const calls = [];
    const child = new EventEmitter();
    const pending = runScript('build.js', ['--project', 'X:\\p\\project.json'], {
      spawnFn: (...args) => { calls.push(args); return child; },
    });
    child.emit('close', 0, null);
    assert.equal(await pending, 0);
    assert.deepEqual(calls, [[
      process.execPath,
      [join(REPO_ROOT, 'build.js'), '--project', 'X:\\p\\project.json'],
      { stdio: 'inherit', cwd: REPO_ROOT },
    ]]);
  });

  test('komut çalışırken SIGINT yok sayılır, bitince dinleyici kaldırılır', async () => {
    const before = process.listenerCount('SIGINT');
    const child = new EventEmitter();
    const pending = runScript('x.js', [], { spawnFn: () => child });
    assert.equal(process.listenerCount('SIGINT'), before + 1);
    child.emit('close', 3, null);
    assert.equal(await pending, 3);
    assert.equal(process.listenerCount('SIGINT'), before);
  });

  test('sinyalle biten süreç 130, başlatılamayan 1; dinleyici her durumda kalkar', async (t) => {
    t.mock.method(process.stderr, 'write', () => true);
    const before = process.listenerCount('SIGINT');

    const signalled = new EventEmitter();
    const p1 = runScript('x.js', [], { spawnFn: () => signalled });
    signalled.emit('close', null, 'SIGTERM');
    assert.equal(await p1, 130);

    const failing = new EventEmitter();
    const p2 = runScript('x.js', [], { spawnFn: () => failing });
    failing.emit('error', new Error('ENOENT'));
    failing.emit('close', null, null);
    assert.equal(await p2, 1);

    const p3 = runScript('x.js', [], { spawnFn: () => { throw new Error('spawn EPERM'); } });
    assert.equal(await p3, 1);

    assert.equal(process.listenerCount('SIGINT'), before);
  });
});

describe('isParentAlive', () => {
  const failWith = (code) => () => { throw Object.assign(new Error(code), { code }); };

  test('gerçek üst süreç (test çalıştırıcısı) yaşıyor', () => {
    assert.equal(isParentAlive(), true);
  });

  test('sinyal 0 ile sorar; ESRCH → sahipsiz, EPERM → yaşıyor', () => {
    const calls = [];
    assert.equal(isParentAlive({ ppid: 42, killFn: (...args) => { calls.push(args); } }), true);
    assert.deepEqual(calls, [[42, 0]]);
    assert.equal(isParentAlive({ ppid: 42, killFn: failWith('ESRCH') }), false);
    assert.equal(isParentAlive({ ppid: 42, killFn: failWith('EPERM') }), true);
  });
});
