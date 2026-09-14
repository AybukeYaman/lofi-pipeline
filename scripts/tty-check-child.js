/**
 * tty-check'in alt süreci: panel bir komutu çalıştırırken stdin'i devralıp
 * geri alabiliyor mu? build.js'in kırpma onayı gibi readline ile soru sorar.
 */

import { createInterface } from 'node:readline/promises';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question('  Alt süreç: bir şey yaz ve Enter: ');
rl.close();
console.log(`  Alt süreç aldı: ${JSON.stringify(answer)}`);
