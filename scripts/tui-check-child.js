/**
 * tui-check'in alt süreci — build.js'in 10b'de kullanacağı IPC protokolünün
 * provası: { type: 'progress' | 'log' | 'done' } gönderir, { type: 'cancel' }
 * alınca "temizlik" yapıp 130 ile çıkar.
 *
 * Windows'ta subprocess.kill('SIGINT') süreci anında öldürür (temizlik
 * çalışmaz) → iptal sinyalle değil IPC mesajıyla.
 *
 *   node scripts/tui-check-child.js [kisa|uzun|test]   (IPC kanalı gerekli)
 */

const DURATIONS = { kisa: 5, uzun: 30, test: 0.4 };
const TAGS = [
  { tag: '02', speed: 1.6 },
  { tag: '04', speed: 1.0 },
  { tag: '03', speed: 0.7 },
];
const TICK_MS = 100;

if (typeof process.send !== 'function') {
  console.error('Bu betik IPC kanalıyla başlatılmalı (tui-check çalıştırır).');
  process.exit(2);
}

const total = DURATIONS[process.argv[2]] ?? DURATIONS.kisa;
let cancelled = false;
process.on('message', (message) => {
  if (message?.type === 'cancel') cancelled = true;
});

const send = (message) => new Promise((resolve) => process.send(message, resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log(`alt süreç başladı (${total} sn)`);
for (let elapsed = 0; elapsed <= total; elapsed += TICK_MS / 1000) {
  if (cancelled) {
    await send({ type: 'log', level: 'warn', message: 'iptal alındı — temizlik yapılıyor' });
    await sleep(200);
    await send({ type: 'log', level: 'info', message: 'temizlik bitti' });
    await send({ type: 'done', code: 130 });
    process.exitCode = 130;
    process.disconnect();
    break;
  }
  for (const { tag, speed } of TAGS) {
    await send({ type: 'progress', tag, seconds: Math.min(total, elapsed * speed), total });
  }
  if (Math.round(elapsed * 10) % 10 === 0) console.log(`çalışıyor: ${elapsed.toFixed(0)} sn`);
  await sleep(TICK_MS);
}

if (!cancelled) {
  await send({ type: 'done', code: 0 });
  process.disconnect();
}
