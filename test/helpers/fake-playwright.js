/**
 * Test yardımcısı: suno-browser-bot'un kullandığı Playwright alt kümesini taklit eder.
 * Gerçek tarayıcı açılmaz, ağa çıkılmaz. Üretim kodunda kullanılmaz.
 *
 * Kullanılan API: browser.newContext/close, context.addCookies/newPage,
 * page.url/goto/locator/$$eval/evaluate, locator.first/count/isVisible/
 * getAttribute/click/fill/waitFor.
 */

/**
 * @param {object} [options]
 * @param {Record<string, { visible?: boolean | (() => boolean), attrs?: object, onClick?: () => void }>} [options.elements]
 *   seçici → sahte eleman. Listede olmayan seçici DOM'da yok sayılır.
 * @param {string[][]} [options.hrefs] $$eval çağrılarının sırayla döndüreceği href listeleri (sonuncusu tekrarlanır)
 * @param {object[][]} [options.rows] evaluate çağrılarının sırayla döndüreceği satırlar (sonuncusu tekrarlanır)
 * @param {string} [options.landingUrl] goto sonrası page.url() (yönlendirme taklidi)
 * @param {Error} [options.gotoError]
 */
export function createFakeBrowser({ elements = {}, hrefs = [[]], rows = [[]], landingUrl, gotoError } = {}) {
  const actions = [];
  const state = { url: 'about:blank', closed: false, cookies: [], hrefCalls: 0, rowCalls: 0, evaluateArgs: [] };

  const pick = (list, index) => list[Math.min(index, list.length - 1)];
  const isVisible = (el) => (typeof el.visible === 'function' ? el.visible() : el.visible !== false);

  function locator(selector) {
    const el = elements[selector];
    const self = {
      first: () => self,
      count: async () => (el ? 1 : 0),
      isVisible: async () => Boolean(el) && isVisible(el),
      getAttribute: async (name) => el?.attrs?.[name] ?? null,
      click: async () => {
        if (!el) throw new Error(`locator.click: ${selector} yok`);
        actions.push({ type: 'click', selector });
        el.onClick?.();
      },
      fill: async (value) => {
        if (!el) throw new Error(`locator.fill: ${selector} yok`);
        actions.push({ type: 'fill', selector, value });
      },
      waitFor: async () => {
        if (!el || !isVisible(el)) throw new Error(`Timeout: ${selector}`);
      },
    };
    return self;
  }

  const page = {
    url: () => state.url,
    goto: async (url, opts) => {
      actions.push({ type: 'goto', url, opts });
      if (gotoError) throw gotoError;
      state.url = landingUrl ?? url;
    },
    locator,
    $$eval: async () => pick(hrefs, state.hrefCalls++),
    evaluate: async (_fn, arg) => {
      state.evaluateArgs.push(arg);
      return pick(rows, state.rowCalls++);
    },
  };

  const context = {
    addCookies: async (cookies) => { state.cookies.push(...cookies); },
    newPage: async () => page,
  };

  const browser = {
    newContext: async () => context,
    close: async () => { state.closed = true; },
  };

  let launches = 0;
  const launchBrowser = async () => {
    launches++;
    return browser;
  };

  return { launchBrowser, actions, state, launches: () => launches };
}

/** Sanal saat: sleepFn beklemeyi anında geçer ve now()'u ilerletir. */
export function createFakeClock() {
  let time = 0;
  const waits = [];
  return {
    now: () => time,
    sleepFn: (done, ms) => {
      waits.push(ms);
      time += ms;
      done();
    },
    waits,
  };
}
