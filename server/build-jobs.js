/**
 * Web UI'dan başlatılan montajlar.
 *
 * build.js, panelde olduğu gibi (ui/runner.js) ayrı süreçte çalışır: çift
 * Ctrl+C'de process.exit çağırıyor ve ffmpeg'i uzun süre tutuyor; sunucunun
 * içinde çalışmamalı. Fark: çıktı terminale değil iş kaydına akar, istek
 * beklemez. Durum yalnızca bellekte tutulur (sunucu yeniden başlarsa kaybolur;
 * asıl sonuç zaten diskteki çıktı dosyasıdır).
 *
 * Aynı anda tek montaj: ffmpeg makineyi zaten doyuruyor, toplu montaj da
 * panelde sıralı.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAX_LOG_LINES = 200;
const MAX_ERROR_LINES = 50;
/** build.js çıkış kodları (build.js → main). */
const EXIT_REASONS = { 1: 'build-failed', 2: 'config-invalid', 130: 'cancelled' };
/** build.js'in hata satırı: "Build başarısız: <neden>". */
const FAILURE_LINE = /^Build başarısız:\s*(.+)$/;

export class BuildAlreadyRunningError extends Error {
  /** @param {string} projectId çalışan montajın projesi */
  constructor(projectId) {
    super('A build is already running');
    this.name = 'BuildAlreadyRunningError';
    this.projectId = projectId;
  }
}

/**
 * @param {{
 *   spawnFn?: typeof spawn,
 *   repoRoot?: string,
 *   now?: () => number,
 * }} [options] testte sahte süreç ve saat için
 */
export function createBuildJobs({ spawnFn = spawn, repoRoot = REPO_ROOT, now = Date.now } = {}) {
  /** @type {Map<string, object>} projectId → son iş */
  const jobs = new Map();
  let runningId = null;

  /**
   * @param {string} projectId
   * @param {{ projectPath: string, overwrite: boolean }} input
   * @returns {object} işin anlık görüntüsü
   */
  function start(projectId, { projectPath, overwrite }) {
    if (runningId !== null) throw new BuildAlreadyRunningError(runningId);

    const job = {
      projectId,
      state: 'running',
      overwrite,
      startedAt: new Date(now()).toISOString(),
      finishedAt: null,
      exitCode: null,
      exitReason: null,
      error: null,
      log: [],
      errorLog: [],
    };
    jobs.set(projectId, job);
    runningId = projectId;

    const finish = (state, { exitCode = null, error = null } = {}) => {
      if (job.state !== 'running') return;
      Object.assign(job, {
        state,
        exitCode,
        exitReason: state === 'succeeded' ? null : (EXIT_REASONS[exitCode] ?? 'failed'),
        error: error ?? (state === 'failed' ? failureSummary(job, exitCode) : null),
        finishedAt: new Date(now()).toISOString(),
      });
      runningId = null;
    };

    let child;
    try {
      child = spawnFn(
        process.execPath,
        [join(repoRoot, 'build.js'), '--project', projectPath, ...(overwrite ? ['--overwrite'] : [])],
        { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
    } catch (error) {
      finish('failed', { error: `build could not be started: ${error.message}` });
      return snapshot(job);
    }

    // log: iki akış birlikte (sıra korunur); errorLog: yalnızca stderr — hata nedeni burada.
    const collectOut = createLineCollector((line) => pushCapped(job.log, line, MAX_LOG_LINES));
    const collectErr = createLineCollector((line) => {
      pushCapped(job.log, line, MAX_LOG_LINES);
      pushCapped(job.errorLog, line, MAX_ERROR_LINES);
    });
    for (const [stream, collect] of [[child.stdout, collectOut], [child.stderr, collectErr]]) {
      stream?.setEncoding('utf8'); // çok baytlı karakter parça sınırında bölünmesin
      stream?.on('data', collect.push);
    }
    const flush = () => {
      collectOut.flush();
      collectErr.flush();
    };
    child.on('error', (error) => {
      flush();
      finish('failed', { error: `build could not be started: ${error.message}` });
    });
    child.on('close', (code, signal) => {
      flush();
      const exitCode = code ?? (signal ? 130 : 1);
      finish(exitCode === 0 ? 'succeeded' : 'failed', { exitCode });
    });

    return snapshot(job);
  }

  /**
   * @param {string} projectId
   * @returns {object} iş yoksa `{ state: 'idle' }`
   */
  function get(projectId) {
    const job = jobs.get(projectId);
    return job ? snapshot(job) : { projectId, state: 'idle' };
  }

  return { start, get };
}

function snapshot(job) {
  return { ...job, log: [...job.log], errorLog: [...job.errorLog] };
}

function pushCapped(lines, line, max) {
  lines.push(line);
  if (lines.length > max) lines.splice(0, lines.length - max);
}

/**
 * Başarısız işin tek satırlık nedeni: build.js'in "Build başarısız: …" satırı,
 * yoksa stderr'in ilk anlamlı satırı (konfig hatası başlığı), yoksa çıkış kodu.
 */
function failureSummary(job, exitCode) {
  for (let i = job.errorLog.length - 1; i >= 0; i -= 1) {
    const match = FAILURE_LINE.exec(job.errorLog[i].trim());
    if (match) return match[1];
  }
  const first = job.errorLog.find((line) => line.trim() !== '');
  return first?.trim() ?? `build.js exited with code ${exitCode}`;
}

/** stdout/stderr parçalarını satırlara böler; build.js TTY yokken \r kullanmaz. */
function createLineCollector(onLine) {
  let pending = '';
  return {
    push(chunk) {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) if (line !== '') onLine(line);
    },
    flush() {
      if (pending !== '') onLine(pending);
      pending = '';
    },
  };
}
