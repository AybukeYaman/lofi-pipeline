/**
 * Aşama 9b — TTY koruması. enquirer TTY olmayan stdin'de yakalanamayan hatayla
 * süreci çökertiyor; panel enquirer'a gitmeden kod 2 ile çıkmalı.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

import { REPO_ROOT } from '../../ui/runner.js';

test('stdin/stdout boruya bağlı → kod 2, anlaşılır mesaj, stack trace yok', async () => {
  const child = spawn(process.execPath, [join(REPO_ROOT, 'lofi.js')], { cwd: REPO_ROOT, stdio: 'pipe' });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdin.end();

  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 2, stderr);
  assert.equal(stdout, '');
  assert.match(stderr, /Panel etkileşimli terminal gerektirir/);
  assert.doesNotMatch(stderr, /Invalid stream passed|\n\s+at /);
});
