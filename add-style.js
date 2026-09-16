/**
 * Görselden stil kartı (style card) üreten CLI komutu.
 *
 * Kullanım:
 *   node add-style.js <görsel> --name <kebab-ad> [--overwrite]
 */

import { copyFile, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { basename, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { listAmbients } from './prep/ambients.js';
import {
  MAX_IMAGE_SIZE_BYTES,
  SUPPORTED_IMAGE_EXTENSIONS,
  buildResponseSchema,
  buildStylePrompt,
  getImageMimeType,
  toStyle,
} from './prep/describe-style.js';
import { generateContent, getApiKey, getModel, listModels, loadEnv } from './prep/gemini.js';
import {
  CUSTOM_STYLE_NAME, STYLES_DIR, STYLE_NAME_PATTERN, findStyleRef, renderStyleBlock,
} from './prep/styles.js';

export class AddStyleError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'AddStyleError';
  }
}

const USAGE = `Kullanım:
  node add-style.js <görsel-yolu> --name <stil-adı> [--overwrite]

  <görsel-yolu>        Stil analizinde kullanılacak görsel (.jpg, .jpeg, .png, .webp, max 15MB)
  --name <stil-adı>    Küçük harf kebab-case stil adı (ör. cozy-realistic)
  --overwrite          Var olan stil dosyasını ve referans görselini ezerek üzerine yazar
  --ambient-dir <yol>  Ortak ambient klasörü (varsayılan: DEFAULT_AMBIENT_DIR)
  --styles-dir <yol>   Stil klasörü (varsayılan: STYLES_DIR)
  -h, --help           Bu yardım metni`;

/** @param {string[]} argv */
export function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      overwrite: { type: 'boolean', default: false },
      'ambient-dir': { type: 'string' },
      'styles-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  return {
    help: values.help,
    imagePath: positionals[0],
    name: values.name,
    overwrite: values.overwrite,
    ambientDir: values['ambient-dir'],
    stylesDir: values['styles-dir'] || STYLES_DIR,
  };
}

/**
 * add-style mantığı.
 *
 * @param {object} params
 * @param {string} params.imagePath
 * @param {string} params.name
 * @param {boolean} [params.overwrite]
 * @param {string} [params.ambientDir]
 * @param {string} [params.stylesDir]
 * @param {object} [params.options] - Testing options (generateContentFn, listModelsFn, listAmbientsFn, readFileFn, statFn, writeFileFn, copyFileFn, rmFn, env, repoRoot)
 */
export async function runAddStyle({
  imagePath,
  name,
  overwrite = false,
  ambientDir,
  stylesDir = STYLES_DIR,
  options = {},
} = {}) {
  // 1. name kontrolü
  if (!name || typeof name !== 'string' || !STYLE_NAME_PATTERN.test(name)) {
    throw new AddStyleError(`geçersiz stil adı "${name}" — küçük harf kebab-case olmalı (ör. "cozy-realistic")`);
  }

  if (name === CUSTOM_STYLE_NAME) {
    throw new AddStyleError(`"${CUSTOM_STYLE_NAME}" adı projeye özel stil için ayrılmış — başka bir ad seçin`);
  }

  // 2. görsel var mı ve uzantı geçerli mi
  if (!imagePath || typeof imagePath !== 'string') {
    throw new AddStyleError('görsel yolu eksik');
  }

  const ext = extname(imagePath).toLowerCase();
  const mimeType = getImageMimeType(ext);
  if (!mimeType || !SUPPORTED_IMAGE_EXTENSIONS.includes(ext)) {
    throw new AddStyleError(
      `desteklenmeyen görsel uzantısı "${ext}" — desteklenenler: ${SUPPORTED_IMAGE_EXTENSIONS.join(', ')}`,
    );
  }

  const statFn = options.statFn || stat;
  let fileStat;
  try {
    fileStat = await statFn(imagePath);
  } catch (cause) {
    throw new AddStyleError(`görsel dosyası bulunamadı veya okunamıyor: ${imagePath}`);
  }

  // 3. boyut kontrolü (15 MB üstü API'ye gitmez)
  if (fileStat.size > MAX_IMAGE_SIZE_BYTES) {
    const sizeMb = (fileStat.size / (1024 * 1024)).toFixed(2);
    throw new AddStyleError(`görsel boyutu çok büyük (${sizeMb} MB) — maksimum 15 MB destekleniyor`);
  }

  // 4. styles/<name>.json varlık ve --overwrite kontrolü
  const jsonPath = join(stylesDir, `${name}.json`);
  const refsDir = join(stylesDir, 'refs');
  const targetRefPath = join(refsDir, `${name}${ext}`);

  const checkStatFn = options.statFn || stat;
  let jsonExists = false;
  try {
    await checkStatFn(jsonPath);
    jsonExists = true;
  } catch {
    jsonExists = false;
  }

  if (jsonExists && !overwrite) {
    throw new AddStyleError(`stil "${name}" zaten var — üzerine yazmak için --overwrite bayrağını kullanın`);
  }

  // 5. API key & env kontrolü
  const repoRoot = options.repoRoot || process.cwd();
  const loadEnvFn = options.loadEnvFn || loadEnv;
  loadEnvFn(repoRoot);

  const env = options.env || process.env;
  const apiKey = getApiKey(env);
  if (!apiKey) {
    throw new AddStyleError('GEMINI_API_KEY bulunamadı. Lütfen .env dosyasına veya ortam değişkenlerine GEMINI_API_KEY ekleyin.');
  }

  // 6. Model doğrulaması (listModels)
  const listModelsFn = options.listModelsFn || listModels;
  const modelsRes = await listModelsFn({ apiKey, options: { env, repoRoot } }).catch((err) => {
    throw new AddStyleError(`Gemini model listesi alınamadı: ${err.message}`);
  });

  const targetModelName = getModel(env);
  const availableModels = modelsRes.models || [];
  const modelExists = availableModels.some((m) => {
    const mName = m.name.replace(/^models\//, '');
    return mName === targetModelName || m.name === targetModelName;
  });

  if (!modelExists) {
    const validNames = availableModels.map((m) => m.name.replace(/^models\//, '')).join(', ');
    throw new AddStyleError(`Seçilen model "${targetModelName}" mevcut değil veya erişilemiyor. Mevcut modeller: ${validNames || '(yok)'}`);
  }

  // 7. Ambient listesi
  const listAmbientsFn = options.listAmbientsFn || listAmbients;
  let ambients = [];
  try {
    ambients = await listAmbientsFn(ambientDir);
  } catch {
    // Ambient okuma hatası kritik değil
  }
  const ambientNames = ambients.map((a) => a.name);

  // 8. Görsel oku ve base64 yap
  const readFileFn = options.readFileFn || readFile;
  const imageBuffer = await readFileFn(imagePath);
  const base64Data = imageBuffer.toString('base64');

  // 9. Prompt ve Schema hazırla
  const promptText = buildStylePrompt({ ambientNames });
  const responseSchema = buildResponseSchema({ ambientNames });

  const contents = [
    {
      parts: [
        { text: promptText },
        {
          inline_data: {
            mime_type: mimeType,
            data: base64Data,
          },
        },
      ],
    },
  ];

  const generationConfig = {
    responseMimeType: 'application/json',
    responseSchema,
  };

  // 10. generateContent çağrısı
  const generateContentFn = options.generateContentFn || generateContent;
  const apiRes = await generateContentFn({
    contents,
    model: targetModelName,
    generationConfig,
    apiKey,
    options: { env, repoRoot, fetchFn: options.fetchFn, sleepFn: options.sleepFn },
  });

  // API cevabından metni çek
  const candidateText = apiRes.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!candidateText) {
    throw new AddStyleError('Gemini beklenmeyen boş bir cevap döndürdü.');
  }

  // 11. Stil nesnesini türet ve doğrula
  const { style } = toStyle(candidateText, name, { ambients });

  // 12. Dosya yazımı (Referans görsel + Stil JSON)
  const copyFileFn = options.copyFileFn || copyFile;
  const writeFileFn = options.writeFileFn || writeFile;
  const rmFn = options.rmFn || rm;

  // --overwrite durumunda eski farklı uzantılı referans görseli varsa temizle
  if (overwrite) {
    const { path: existingRef } = await findStyleRef(name, { dir: stylesDir }).catch(() => ({ path: null }));
    if (existingRef && existingRef !== targetRefPath) {
      await rmFn(existingRef, { force: true }).catch(() => {});
    }
  }

  // Önce referans görseli kopyala
  await copyFileFn(imagePath, targetRefPath);

  // Stil JSON'ını yaz
  const jsonContent = JSON.stringify(style, null, 2) + '\n';
  try {
    await writeFileFn(jsonPath, jsonContent, 'utf8');
  } catch (err) {
    // JSON yazımı başarısız olursa kopyalanan referans görselini geri sil
    await rmFn(targetRefPath, { force: true }).catch(() => {});
    throw new AddStyleError(`Stil dosyası yazılamadı: ${err.message}`);
  }

  return {
    name,
    jsonPath,
    refPath: targetRefPath,
    style,
    renderedBlock: renderStyleBlock(style),
  };
}

/** @param {Awaited<ReturnType<typeof runAddStyle>>} result */
function describeResult(result) {
  const relJson = resolve(result.jsonPath);
  const relRef = resolve(result.refPath);

  return [
    `Stil başarıyla eklendi: ${result.name}`,
    `  JSON: ${relJson}`,
    `  Ref : ${relRef}`,
    '',
    'Stil Bloğu Önizlemesi:',
    '----------------------------------------',
    result.renderedBlock,
    '----------------------------------------',
    '',
    'Sıradaki adım:',
    `  node new-video.js "yeni-proje" --style ${result.name}`,
  ].join('\n');
}

/**
 * CLI girişi. Çıkış kodları: 0 başarı · 1 sistem/yazım hatası · 2 kullanım/doğrulama hatası.
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv, options = {}) {
  let cli;
  try {
    cli = parseCli(argv);
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }

  if (cli.help) {
    console.log(USAGE);
    return 0;
  }

  if (!cli.name || !cli.imagePath) {
    console.error(`Eksik parametreler.\n\n${USAGE}`);
    return 2;
  }

  try {
    const result = await runAddStyle({
      imagePath: cli.imagePath,
      name: cli.name,
      overwrite: cli.overwrite,
      ambientDir: cli.ambientDir,
      stylesDir: cli.stylesDir,
      options,
    });
    console.log(describeResult(result));
    return 0;
  } catch (error) {
    if (error instanceof AddStyleError) {
      console.error(error.message);
      return 2;
    }
    console.error(`Stil eklenemedi: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
