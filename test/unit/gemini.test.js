import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_GEMINI_MODEL,
  GeminiError,
  generateContent,
  getApiKey,
  getModel,
  listModels,
} from '../../prep/gemini.js';

test('1. başarılı generateContent request', async () => {
  const fakeResponseData = {
    candidates: [
      {
        content: {
          parts: [{ text: 'Merhaba Gemini' }],
        },
      },
    ],
  };

  let capturedUrl = '';
  let capturedOptions = {};

  const fakeFetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify(fakeResponseData),
    };
  };

  const res = await generateContent({
    contents: [{ parts: [{ text: 'Selam' }] }],
    apiKey: 'AIzaSyTestKey12345678901234567890123456',
    options: { fetchFn: fakeFetch },
  });

  assert.deepEqual(res, fakeResponseData);
  assert.match(capturedUrl, /https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-[0-9\.]+-flash:generateContent/);
  assert.equal(capturedOptions.method, 'POST');
});

test('2. API key\'in header\'da (x-goog-api-key) gönderilmesi', async () => {
  const testKey = 'AIzaSyHeaderKey9999999999999999999999999';
  let capturedHeaders = {};

  const fakeFetch = async (url, options) => {
    capturedHeaders = options.headers;
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ ok: true }),
    };
  };

  await generateContent({
    contents: [{ parts: [{ text: 'test' }] }],
    apiKey: testKey,
    options: { fetchFn: fakeFetch },
  });

  assert.equal(capturedHeaders['x-goog-api-key'], testKey);
});

test('3. API key\'in URL query parametresinde OLMAMASI', async () => {
  const testKey = 'AIzaSySecretKeyNoUrl12345678901234567890';
  let capturedUrl = '';

  const fakeFetch = async (url) => {
    capturedUrl = url;
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ ok: true }),
    };
  };

  await generateContent({
    contents: [{ parts: [{ text: 'test' }] }],
    apiKey: testKey,
    options: { fetchFn: fakeFetch },
  });

  assert.equal(capturedUrl.includes('key='), false);
  assert.equal(capturedUrl.includes(testKey), false);
});

test('4. 429 sonrası retry yapılması', async () => {
  let callCount = 0;
  const sleepMs = [];

  const fakeFetch = async () => {
    callCount++;
    if (callCount === 1) {
      return {
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': '2' }),
        text: async () => JSON.stringify({ error: { message: 'Rate limit' } }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ success: true }),
    };
  };

  const fakeSleep = (cb, ms) => {
    sleepMs.push(ms);
    cb();
  };

  const res = await generateContent({
    contents: [{ parts: [{ text: 'test' }] }],
    apiKey: 'AIzaSyTestKey123',
    options: { fetchFn: fakeFetch, sleepFn: fakeSleep },
  });

  assert.equal(callCount, 2);
  assert.deepEqual(res, { success: true });
  assert.equal(sleepMs[0], 2000); // retry-after 2sn = 2000ms
});

test('5. 500 / 503 sonrası retry yapılması (exponential backoff)', async () => {
  let callCount = 0;
  const sleepMs = [];

  const fakeFetch = async () => {
    callCount++;
    if (callCount <= 2) {
      return {
        ok: false,
        status: 503,
        headers: new Headers(),
        text: async () => JSON.stringify({ error: { message: 'Service Unavailable' } }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ success: true }),
    };
  };

  const fakeSleep = (cb, ms) => {
    sleepMs.push(ms);
    cb();
  };

  const res = await generateContent({
    contents: [{ parts: [{ text: 'test' }] }],
    apiKey: 'AIzaSyTestKey123',
    options: { fetchFn: fakeFetch, sleepFn: fakeSleep },
  });

  assert.equal(callCount, 3);
  assert.deepEqual(res, { success: true });
  assert.equal(sleepMs[0], 1000); // 1. denemede 1000ms
  assert.equal(sleepMs[1], 2000); // 2. denemede 2000ms
});

test('6. PerDay quota durumunda retry YAPILMAMASI', async () => {
  let callCount = 0;

  const fakeFetch = async () => {
    callCount++;
    return {
      ok: false,
      status: 429,
      headers: new Headers(),
      text: async () =>
        JSON.stringify({
          error: {
            message: 'Quota exceeded for QuotaGroup PerDay',
            details: [{ reason: 'QUOTA_EXCEEDED_PER_DAY' }],
          },
        }),
    };
  };

  await assert.rejects(
    async () => {
      await generateContent({
        contents: [{ parts: [{ text: 'test' }] }],
        apiKey: 'AIzaSyTestKey123',
        options: { fetchFn: fakeFetch },
      });
    },
    (err) => {
      assert.ok(err instanceof GeminiError);
      assert.equal(err.quotaExceeded, true);
      assert.equal(err.status, 429);
      return true;
    },
  );

  assert.equal(callCount, 1); // Tekrar denenmedi!
});

test('7. 400 / 403 / 404 durumunda retry YAPILMAMASI', async () => {
  for (const status of [400, 403, 404]) {
    let callCount = 0;

    const fakeFetch = async () => {
      callCount++;
      return {
        ok: false,
        status,
        headers: new Headers(),
        text: async () => JSON.stringify({ error: { message: `Fatal client error ${status}` } }),
      };
    };

    await assert.rejects(
      async () => {
        await generateContent({
          contents: [{ parts: [{ text: 'test' }] }],
          apiKey: 'AIzaSyTestKey123',
          options: { fetchFn: fakeFetch },
        });
      },
      (err) => {
        assert.ok(err instanceof GeminiError);
        assert.equal(err.status, status);
        return true;
      },
    );

    assert.equal(callCount, 1);
  }
});

test('8. Retry limitinin aşılması durumunda hata fırlatılması', async () => {
  let callCount = 0;

  const fakeFetch = async () => {
    callCount++;
    return {
      ok: false,
      status: 500,
      headers: new Headers(),
      text: async () => JSON.stringify({ error: { message: 'Internal Server Error' } }),
    };
  };

  const fakeSleep = (cb) => cb();

  await assert.rejects(
    async () => {
      await generateContent({
        contents: [{ parts: [{ text: 'test' }] }],
        apiKey: 'AIzaSyTestKey123',
        options: { fetchFn: fakeFetch, sleepFn: fakeSleep, maxRetries: 3 },
      });
    },
    (err) => {
      assert.ok(err instanceof GeminiError);
      assert.equal(err.status, 500);
      return true;
    },
  );

  assert.equal(callCount, 4); // 1 ilk deneme + 3 retry = 4 toplam çağrı
});

test('9. API key eksikliği durumunda anlaşılır hata', async () => {
  await assert.rejects(
    async () => {
      await generateContent({
        contents: [{ parts: [{ text: 'test' }] }],
        options: { env: {} },
      });
    },
    (err) => {
      assert.ok(err instanceof GeminiError);
      assert.equal(err.status, 401);
      assert.match(err.message, /GEMINI_API_KEY bulunamadı/);
      return true;
    },
  );
});

test('10. listModels response parsing', async () => {
  const fakeModelsResponse = {
    models: [
      {
        name: 'models/gemini-1.5-flash',
        displayName: 'Gemini 1.5 Flash',
        description: 'Fast and versatile model',
      },
      {
        name: 'models/gemini-1.5-pro',
        displayName: 'Gemini 1.5 Pro',
        description: 'Complex reasoning model',
      },
    ],
  };

  let capturedUrl = '';
  let capturedHeaders = {};

  const fakeFetch = async (url, options) => {
    capturedUrl = url;
    capturedHeaders = options.headers;
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify(fakeModelsResponse),
    };
  };

  const res = await listModels({
    apiKey: 'AIzaSyListModelsKey123',
    options: { fetchFn: fakeFetch },
  });

  assert.deepEqual(res, fakeModelsResponse);
  assert.equal(capturedUrl, 'https://generativelanguage.googleapis.com/v1beta/models');
  assert.equal(capturedHeaders['x-goog-api-key'], 'AIzaSyListModelsKey123');
});

test('11. GEMINI_MODEL override ve varsayılan model kontrolü', () => {
  assert.equal(DEFAULT_GEMINI_MODEL, 'gemini-1.5-flash');
  assert.equal(getModel({}), 'gemini-1.5-flash');
  assert.equal(getModel({ GEMINI_MODEL: 'gemini-1.5-pro' }), 'gemini-1.5-pro');
  assert.equal(getApiKey({ GEMINI_API_KEY: 'secret' }), 'secret');
});

test('12. her denemede zaman aşımı sinyali; asılı istek süreci süresiz tutmaz', async () => {
  const signals = [];
  const fakeFetch = async (url, options) => {
    signals.push(options.signal);
    if (signals.length === 1) throw new Error('timeout');
    return { ok: true, status: 200, headers: new Headers(), text: async () => '{}' };
  };

  await generateContent({
    contents: [{ parts: [{ text: 'x' }] }],
    apiKey: 'AIzaSyTimeoutKey',
    options: { fetchFn: fakeFetch, sleepFn: (resolve) => resolve() },
  });

  assert.equal(signals.length, 2);
  for (const signal of signals) assert.ok(signal instanceof AbortSignal);
  assert.notEqual(signals[0], signals[1], 'retry yeni süre ile başlamalı');
});
