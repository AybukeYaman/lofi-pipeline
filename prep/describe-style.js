/**
 * Görsel stil analizi için prompt ve JSON şeması üretimi ile cevap ayrıştırma.
 *
 * Network çağrısı yapmaz.
 */

import { CUSTOM_STYLE_NAME, STYLE_FIELDS, validateStyle } from './styles.js';

export const MAX_IMAGE_SIZE_BYTES = 15 * 1024 * 1024; // 15 MB

export const SUPPORTED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

/**
 * Görsel uzantısından MIME type belirler.
 * @param {string} ext
 * @returns {string | null}
 */
export function getImageMimeType(ext) {
  const normalized = ext.toLowerCase();
  switch (normalized) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    default:
      return null;
  }
}

/**
 * Gemini'ye gönderilecek Türkçe prompt metnini kurar.
 * @param {{ ambientNames: string[] }} options
 * @returns {string}
 */
export function buildStylePrompt({ ambientNames = [] } = {}) {
  const ambientListStr = ambientNames.length > 0 ? ambientNames.join(', ') : 'hiçbiri';

  return (
    'Bu görselin görsel stilini bir prompt fragmanı olarak tarif et.\n' +
    'Konuyu ve kompozisyonu ANLATMA, sadece stili anlat.\n\n' +
    'Kurallar:\n' +
    '- Çıktı tamamen İngilizce olacak.\n' +
    '- palette: 5 ila 8 renk içermeli. Her renk hex (#RRGGBB) formatında olmalı ve rolü (role) açıklanmalı.\n' +
    `- suggestedAmbient: Yalnızca şu listeden seçilmelidir: [${ambientListStr}].\n` +
    '- motionHints: 4 ila 6 adet hareket ipucu tarif et.\n' +
    '- motionHints: Yalnızca döngüye (loop) uygun subtle hareketleri tarif et.\n' +
    '- pan, zoom, camera moves veya nesne takibi asla önerme (camera static kalmalı).\n' +
    '- Stil bozulmadan hareket edebilecek öğelere odaklan.\n' +
    '- Metinlerde "<", ">", "{{" veya markdown ("**", "*") kullanılmayacak.\n' +
    '- Konu ve kompozisyon detayları styleBlock alanlarına taşınmayacak.'
  );
}

/**
 * Birden fazla referans görsel ve video konsepti ile Gemini'ye gönderilecek prompt metnini kurar.
 * @param {{ concept?: string, ambientNames?: string[] }} options
 * @returns {string}
 */
export function buildMultiReferenceStylePrompt({ concept = '', ambientNames = [] } = {}) {
  const ambientListStr = ambientNames.length > 0 ? ambientNames.join(', ') : 'hiçbiri';
  const conceptPart = concept ? `Video Concept Context: "${concept}"\n` : '';

  return (
    'Verilen referans görsellerin ortak visual language / ambience özelliklerini ve görsel stilini sentezle.\n' +
    conceptPart +
    'Kurallar:\n' +
    '- Çıktı tamamen İngilizce olacak.\n' +
    '- Görsellerin ortak ve baskın görsel dilini (production technique, line quality, palette, lighting, texture, contrast, shading, mood) çıkar.\n' +
    '- Bir görseldeki rastgele/aykırı bir detayı global stile taşıma; ortak patternleri ve genel ambience ortamını esas al.\n' +
    '- Konuyu veya sahneyi (WHAT IS HAPPENING) ANLATMA, sadece stili ve atmosferi (HOW IT LOOKS) anlat.\n' +
    '- palette: Referans görsellerden baskın/destekleyici 5 ila 8 renk seç. Her renk hex (#RRGGBB) formatında olmalı ve rolü (role) belirtilmeli.\n' +
    `- suggestedAmbient: Yalnızca şu listeden seçilmelidir: [${ambientListStr}].\n` +
    '- motionHints: 4 ila 6 adet döngüye (loop) uygun subtle hareket ipucu tarif et (camera static kalmalı, pan/zoom yok).\n' +
    '- Metinlerde "<", ">", "{{" veya markdown ("**", "*") kullanılmayacak.\n' +
    '- Konu ve kompozisyon detayları styleBlock alanlarına asla sızmayacak.'
  );
}

/**
 * Gemini API için Structured Outputs JSON Şeması kurar.
 * @param {{ ambientNames: string[] }} options
 * @returns {object}
 */
export function buildResponseSchema({ ambientNames = [] } = {}) {
  const styleBlockProperties = {};
  const requiredStyleFields = [];

  for (const { key } of STYLE_FIELDS) {
    requiredStyleFields.push(key);
    if (key === 'palette') {
      styleBlockProperties[key] = {
        type: 'ARRAY',
        description: '5-8 dominant colors with hex code and role',
        items: {
          type: 'OBJECT',
          properties: {
            hex: { type: 'STRING', description: 'Hex color code e.g. #FF0000' },
            role: { type: 'STRING', description: 'Role of the color e.g. primary background' },
          },
          required: ['hex', 'role'],
        },
      };
    } else {
      styleBlockProperties[key] = {
        type: 'STRING',
        description: `Description for ${key}`,
      };
    }
  }

  const schema = {
    type: 'OBJECT',
    properties: {
      styleBlock: {
        type: 'OBJECT',
        properties: styleBlockProperties,
        required: requiredStyleFields,
      },
      suggestedAmbient: {
        type: 'STRING',
        description: 'Suggested ambient audio from provided list',
      },
      motionHints: {
        type: 'ARRAY',
        description: '4-6 looping motion hints',
        items: { type: 'STRING' },
      },
    },
    required: ['styleBlock', 'suggestedAmbient', 'motionHints'],
  };

  if (ambientNames.length > 0) {
    schema.properties.suggestedAmbient.enum = ambientNames;
  }

  return schema;
}

/**
 * Gemini responseText metnini alır, JSON parse eder, name ekler ve validateStyle() ile doğrular.
 * @param {string} responseText
 * @param {string} name
 * @param {{ ambients?: { name: string, path: string }[] }} [options]
 * @returns {{ style: object, warnings: string[] }}
 */
export function toStyle(responseText, name, { ambients } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch (cause) {
    throw new Error(`Gemini çıktısı geçerli bir JSON değil: ${cause.message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Gemini çıktısı bir JSON nesnesi olmalı.');
  }

  const styleObj = {
    name,
    styleBlock: parsed.styleBlock,
    suggestedAmbient: parsed.suggestedAmbient,
    motionHints: parsed.motionHints,
  };

  const { problems, warnings } = validateStyle(styleObj, { expectedName: name, ambients });
  if (problems.length > 0) {
    throw new Error(`Gemini tarafından üretilen stil geçersiz:\n` + problems.map((p) => `  - ${p}`).join('\n'));
  }

  return { style: styleObj, warnings };
}

/**
 * Birden fazla görsel dosyası ve konsept parametresi alarak Gemini API ile stil analizi yapar.
 * @param {object} params
 * @param {string[]} params.imagePaths
 * @param {string} [params.concept]
 * @param {string} [params.name]
 * @param {object} [params.options]
 * @returns {Promise<{ style: object, warnings: string[] }>}
 */
export async function describeMultiReferenceStyle({
  imagePaths = [],
  concept = '',
  name = CUSTOM_STYLE_NAME,
  options = {},
} = {}) {
  const { extname } = await import('node:path');
  const { readFile } = await import('node:fs/promises');
  const { listAmbients } = await import('./ambients.js');
  const { generateContent, getApiKey, getModel, loadEnv } = await import('./gemini.js');

  if (!Array.isArray(imagePaths) || imagePaths.length === 0) {
    throw new Error('At least one reference image path is required for style synthesis.');
  }

  const repoRoot = options.repoRoot || process.cwd();
  const loadEnvFn = options.loadEnvFn || loadEnv;
  loadEnvFn(repoRoot);

  const env = options.env || process.env;
  const apiKey = getApiKey(env);
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY bulunamadı. Lütfen .env dosyasına veya ortam değişkenlerine GEMINI_API_KEY ekleyin.');
  }

  const targetModelName = getModel(env);
  const listAmbientsFn = options.listAmbientsFn || listAmbients;
  let ambients = [];
  try {
    ambients = await listAmbientsFn(options.ambientDir);
  } catch {}
  const ambientNames = ambients.map((a) => a.name);

  const readFileFn = options.readFileFn || readFile;
  const parts = [];

  const promptText = buildMultiReferenceStylePrompt({ concept, ambientNames });
  parts.push({ text: promptText });

  for (const imgPath of imagePaths) {
    const ext = extname(imgPath).toLowerCase();
    const mimeType = getImageMimeType(ext);
    if (!mimeType) continue;

    const buffer = await readFileFn(imgPath);
    parts.push({
      inline_data: {
        mime_type: mimeType,
        data: buffer.toString('base64'),
      },
    });
  }

  const responseSchema = buildResponseSchema({ ambientNames });
  const contents = [{ parts }];
  const generationConfig = {
    responseMimeType: 'application/json',
    responseSchema,
  };

  const generateContentFn = options.generateContentFn || generateContent;
  const apiRes = await generateContentFn({
    contents,
    model: targetModelName,
    generationConfig,
    apiKey,
    options: { env, repoRoot, fetchFn: options.fetchFn, sleepFn: options.sleepFn },
  });

  const candidateText = apiRes.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!candidateText) {
    throw new Error('Gemini beklenmeyen boş bir cevap döndürdü.');
  }

  return toStyle(candidateText, name, { ambients });
}
