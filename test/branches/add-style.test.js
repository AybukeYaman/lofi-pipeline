import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { AddStyleError, main, runAddStyle } from '../../add-style.js';
import { GeminiError } from '../../prep/gemini.js';

const TEST_DIR = join(process.cwd(), 'test-scratch-add-style');

async function setupTestDir() {
  await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(join(TEST_DIR, 'styles', 'refs'), { recursive: true });
}

async function cleanupTestDir() {
  await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
}

const fakeValidGeminiResponse = {
  candidates: [
    {
      content: {
        parts: [
          {
            text: JSON.stringify({
              styleBlock: {
                medium: 'Watercolor on paper',
                lines: 'Soft feathered edges',
                palette: [
                  { hex: '#112233', role: 'base' },
                  { hex: '#445566', role: 'light' },
                  { hex: '#778899', role: 'accent' },
                  { hex: '#AABBCC', role: 'shadow' },
                  { hex: '#DDEEFF', role: 'highlight' },
                ],
                light: 'Diffused daylight',
                texture: 'Paper grain',
                contrast: 'Low contrast',
                shading: 'Soft washes',
              },
              suggestedAmbient: 'heavyRain',
              motionHints: [
                'Steam rising gently.',
                'Soft rain falling in background.',
                'Flickering candle flame.',
                'Curtain swaying subtly in breeze.',
              ],
            }),
          },
        ],
      },
    },
  ],
};

test('1. Başarılı stil üretimi ve dosya yazımı', async () => {
  await setupTestDir();
  const stylesDir = join(TEST_DIR, 'styles');
  const dummyImage = join(TEST_DIR, 'sample.jpg');
  await writeFile(dummyImage, Buffer.from('fake-image-bytes'));

  let capturedGenerateArgs = null;

  const fakeListModels = async () => ({
    models: [{ name: 'models/gemini-1.5-flash' }],
  });

  const fakeGenerateContent = async (args) => {
    capturedGenerateArgs = args;
    return fakeValidGeminiResponse;
  };

  const result = await runAddStyle({
    imagePath: dummyImage,
    name: 'test-watercolor',
    stylesDir,
    options: {
      env: { GEMINI_API_KEY: 'AIzaSyTest123' },
      listModelsFn: fakeListModels,
      generateContentFn: fakeGenerateContent,
    },
  });

  assert.equal(result.name, 'test-watercolor');
  assert.equal(result.jsonPath, join(stylesDir, 'test-watercolor.json'));
  assert.equal(result.refPath, join(stylesDir, 'refs', 'test-watercolor.jpg'));

  // Request parametrelerinin doğrulanması
  assert.equal(capturedGenerateArgs.contents[0].parts[1].inline_data.mime_type, 'image/jpeg');
  assert.equal(capturedGenerateArgs.generationConfig.responseMimeType, 'application/json');

  await cleanupTestDir();
});

test('2. Style zaten varsa --overwrite olmadan kod 2 fırlatılması ve API çağrılmaması', async () => {
  await setupTestDir();
  const stylesDir = join(TEST_DIR, 'styles');
  const dummyImage = join(TEST_DIR, 'sample.jpg');
  await writeFile(dummyImage, Buffer.from('fake-image-bytes'));
  await writeFile(join(stylesDir, 'existing-style.json'), '{}');

  let apiCalled = false;

  await assert.rejects(
    async () => {
      await runAddStyle({
        imagePath: dummyImage,
        name: 'existing-style',
        overwrite: false,
        stylesDir,
        options: {
          env: { GEMINI_API_KEY: 'AIzaSyTest123' },
          generateContentFn: async () => {
            apiCalled = true;
            return fakeValidGeminiResponse;
          },
        },
      });
    },
    (err) => {
      assert.ok(err instanceof AddStyleError);
      assert.match(err.message, /zaten var — üzerine yazmak için --overwrite/);
      return true;
    },
  );

  assert.equal(apiCalled, false);
  await cleanupTestDir();
});

test('3. --overwrite ile eski farklı uzantılı ref görselinin temizlenmesi', async () => {
  await setupTestDir();
  const stylesDir = join(TEST_DIR, 'styles');
  const dummyPng = join(TEST_DIR, 'sample.png');
  await writeFile(dummyPng, Buffer.from('fake-png-bytes'));

  // Eskiden kalma .jpg ref görseli ve json
  await writeFile(join(stylesDir, 'existing-style.json'), '{}');
  const oldJpgRef = join(stylesDir, 'refs', 'existing-style.jpg');
  await writeFile(oldJpgRef, Buffer.from('old-jpg'));

  let deletedOldRef = false;
  const fakeRm = async (path) => {
    if (path === oldJpgRef) deletedOldRef = true;
  };

  const fakeListModels = async () => ({
    models: [{ name: 'models/gemini-1.5-flash' }],
  });

  const result = await runAddStyle({
    imagePath: dummyPng,
    name: 'existing-style',
    overwrite: true,
    stylesDir,
    options: {
      env: { GEMINI_API_KEY: 'AIzaSyTest123' },
      listModelsFn: fakeListModels,
      generateContentFn: async () => fakeValidGeminiResponse,
      rmFn: fakeRm,
    },
  });

  assert.equal(result.refPath, join(stylesDir, 'refs', 'existing-style.png'));
  assert.equal(deletedOldRef, true);
  await cleanupTestDir();
});

test('4. Geçersiz Gemini response durumunda style dosyası oluşturulmaması', async () => {
  await setupTestDir();
  const stylesDir = join(TEST_DIR, 'styles');
  const dummyImage = join(TEST_DIR, 'sample.jpg');
  await writeFile(dummyImage, Buffer.from('fake-image-bytes'));

  const fakeInvalidGeminiResponse = {
    candidates: [
      {
        content: {
          parts: [{ text: 'NOT VALID JSON' }],
        },
      },
    ],
  };

  let createdRef = false;
  const fakeCopy = async () => {
    createdRef = true;
  };

  await assert.rejects(
    async () => {
      await runAddStyle({
        imagePath: dummyImage,
        name: 'invalid-resp-style',
        stylesDir,
        options: {
          env: { GEMINI_API_KEY: 'AIzaSyTest123' },
          listModelsFn: async () => ({ models: [{ name: 'models/gemini-1.5-flash' }] }),
          generateContentFn: async () => fakeInvalidGeminiResponse,
          copyFileFn: fakeCopy,
        },
      });
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Gemini çıktısı geçerli bir JSON değil/);
      return true;
    },
  );

  assert.equal(createdRef, false);
  await cleanupTestDir();
});

test('5. Geçersiz stil adı veya olmayan görsel durumunda API çağrılmaması', async () => {
  let apiCalled = false;
  const fakeGenerate = async () => {
    apiCalled = true;
    return fakeValidGeminiResponse;
  };

  // Geçersiz stil adı
  await assert.rejects(
    async () => {
      await runAddStyle({
        imagePath: 'valid.jpg',
        name: 'Invalid_Style_Name!',
        options: { generateContentFn: fakeGenerate },
      });
    },
    (err) => err instanceof AddStyleError,
  );
  assert.equal(apiCalled, false);

  // Projeye özel stil adı ayrılmış: loadStyle bu adı dosyaya bakmadan karşılar.
  await assert.rejects(
    runAddStyle({ imagePath: 'valid.jpg', name: 'custom-generated', options: { generateContentFn: fakeGenerate } }),
    (err) => err instanceof AddStyleError && /ayrılmış/.test(err.message),
  );
  assert.equal(apiCalled, false);

  // Olmayan görsel
  await assert.rejects(
    async () => {
      await runAddStyle({
        imagePath: 'non-existent-image-12345.jpg',
        name: 'valid-name',
        options: { generateContentFn: fakeGenerate },
      });
    },
    (err) => err instanceof AddStyleError,
  );
  assert.equal(apiCalled, false);
});

test('6. API Key yokluğunda hata fırlatılması ve API Key sızdırılmaması', async () => {
  const dummyImage = join(TEST_DIR, 'sample.jpg');
  await setupTestDir();
  await writeFile(dummyImage, Buffer.from('fake'));

  await assert.rejects(
    async () => {
      await runAddStyle({
        imagePath: dummyImage,
        name: 'test-key-missing',
        stylesDir: join(TEST_DIR, 'styles'),
        options: { env: {} },
      });
    },
    (err) => {
      assert.ok(err instanceof AddStyleError);
      assert.match(err.message, /GEMINI_API_KEY bulunamadı/);
      return true;
    },
  );

  await cleanupTestDir();
});

test('7. add-style çıktısının new-video komutu ile uyumlu öneri içermesi', async () => {
  await setupTestDir();
  const stylesDir = join(TEST_DIR, 'styles');
  const dummyImage = join(TEST_DIR, 'sample.jpg');
  await writeFile(dummyImage, Buffer.from('fake-image-bytes'));

  const result = await runAddStyle({
    imagePath: dummyImage,
    name: 'cyberpunk-neon',
    stylesDir,
    options: {
      env: { GEMINI_API_KEY: 'AIzaSyTest123' },
      listModelsFn: async () => ({ models: [{ name: 'models/gemini-1.5-flash' }] }),
      generateContentFn: async () => fakeValidGeminiResponse,
    },
  });

  assert.ok(result.renderedBlock.includes('Medium / technique: Watercolor on paper'));

  // Main CLI test
  let consoleOutput = '';
  const origLog = console.log;
  console.log = (msg) => {
    consoleOutput += msg + '\n';
  };

  const exitCode = await main(
    [
      dummyImage,
      '--name',
      'cli-test-style',
      '--styles-dir',
      stylesDir,
    ],
    {
      env: { GEMINI_API_KEY: 'AIzaSyTest123' },
      listModelsFn: async () => ({ models: [{ name: 'models/gemini-1.5-flash' }] }),
      generateContentFn: async () => fakeValidGeminiResponse,
    },
  );

  console.log = origLog;

  assert.equal(exitCode, 0);
  assert.match(consoleOutput, /Stil başarıyla eklendi: cli-test-style/);
  assert.match(consoleOutput, /node new-video\.js "yeni-proje" --style cli-test-style/);

  await cleanupTestDir();
});
