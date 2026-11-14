#!/usr/bin/env node
'use strict';
const {guardBrowserClose} = require('./testing/owned-browser-close.cjs');

// Production cache settings regression in a disposable, focus-safe Edge profile.
// Provider responses and bulk cache records are explicitly labeled fixtures;
// runtime routing, cache writes/reads, IndexedDB pruning and settings saves are real.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const execFileAsync = promisify(execFile);

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const extensionDir = path.resolve(argument('extension-dir', '.output/chrome-mv3'));
const playwrightRoot = argument('playwright-root', '');
const helperPath = argument('focus-safe-helper', process.env.FLUENTREAD_FOCUS_SAFE_HELPER || path.join(__dirname, 'testing/focus-safe-browser.cjs'));
const artifactsDir = path.resolve(argument('artifacts-dir', '/private/tmp/fluentread-cache-settings-production'));
const timeout = Number(argument('timeout', '30000'));
const MIB = 1024 * 1024;
const cardSelector = '[data-translation-cache-settings]';
const expectedNavigationIds = [
  'settings-general', 'settings-services', 'settings-translation', 'settings-interface',
  'settings-harness', 'settings-image-translation', 'settings-area-translation', 'settings-video',
  'settings-sites', 'settings-writing', 'settings-translation-center', 'settings-vocabulary',
  'settings-glossary', 'settings-model-usage', 'settings-advanced', 'settings-data',
];
assert.ok(playwrightRoot, 'Supply --playwright-root');
assert.ok(helperPath && fs.existsSync(helperPath), 'Supply the skill --focus-safe-helper');
assert.ok(fs.existsSync(path.join(extensionDir, 'manifest.json')), 'Build the production extension first');
assert.equal(path.basename(extensionDir), 'chrome-mv3', 'This delivery suite requires production chrome-mv3');
const {chromium} = require(path.join(path.resolve(playwrightRoot), 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground} = require(path.resolve(helperPath));
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
fs.mkdirSync(artifactsDir, {recursive: true});
let profileDir;
const report = {
  ok: false, suite: 'cache-settings', artifact: 'production', extensionDir, profileDir,
  manifestVersion: manifest.version,
  backgroundArtifact: {
    path: manifest.background.service_worker,
    sha256: createHash('sha256').update(fs.readFileSync(path.join(extensionDir, manifest.background.service_worker))).digest('hex'),
  },
  browser: 'Microsoft Edge', fixtureScope: {
    provider: 'Google RPC response fixture injected only in isolated extension worker; real runtime broker and cache',
    bulkRecords: 'IndexedDB fixtures in isolated profile; not evidence of real site translation',
    failures: 'Page-local runtime response injection; real production error UI and retry behavior',
  }, caseCoverage: [], screenshots: [], consoleErrors: [], persistenceCases: [],
  quickClose: false, crossPageSync: false, latestWriteWins: false, errors: [],
};
let browserSession;
let context;
let page;
let worker;
let browserPid;

function record(name, evidence = {}) {
  report.caseCoverage.push({name, passed: true, ...evidence});
  process.stdout.write(`PASS ${name}\n`);
}
function captureErrors(target, label) {
  target.on('console', message => {
    if (message.type() === 'error') report.consoleErrors.push({label, message: message.text()});
  });
  target.on('pageerror', error => report.consoleErrors.push({label, message: String(error)}));
}
async function assertBackground(label) {
  const {stdout} = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
    "ObjC.import('AppKit'); const app = $.NSWorkspace.sharedWorkspace.frontmostApplication; JSON.stringify({pid:Number(app.processIdentifier),name:ObjC.unwrap(app.localizedName)});",
  ], {timeout: 5000});
  const frontmost = JSON.parse(stdout.trim());
  assert.notEqual(frontmost.pid, browserPid, `Test browser became foreground at ${label}`);
  report.focusChecks ||= [];
  report.focusChecks.push({label, browserFrontmost: false, frontmost});
}
async function screenshot(name) {
  await assertBackground(name);
  const file = path.join(artifactsDir, `${name}.png`);
  await page.screenshot({path: file});
  report.screenshots.push(file);
  return file;
}
async function message(payload) {
  return page.evaluate(value => chrome.runtime.sendMessage(value), payload);
}
async function stats() {
  const response = await message({type: 'getTranslationCacheStats'});
  assert.equal(response?.success, true, JSON.stringify(response));
  return response.stats;
}
async function readConfig() {
  const response = await message({type: 'configStorageRead', key: 'local:config'});
  assert.equal(response?.success, true, JSON.stringify(response));
  return response.value;
}
async function openOptions() {
  const opened = await newPageWithoutForeground(context, timeout);
  captureErrors(opened, 'options');
  await opened.setViewportSize({width: 1280, height: 900});
  // Install before the production bundle binds the browser polyfill. All ordinary
  // messages retain their actual callbacks/results; only named fault cases differ.
  await opened.addInitScript(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.__cacheFault = '';
    window.__cacheMessages = [];
    chrome.runtime.sendMessage = (...args) => {
      const request = args[0];
      const entry = {type: request?.type, sent: Date.now()};
      if (request?.type === 'persistConfig') entry.patch = request.config;
      window.__cacheMessages.push(entry);
      const callback = typeof args.at(-1) === 'function' ? args.at(-1) : null;
      if (window.__cacheFault === request?.type) {
        const response = {success: false, error: 'Deliberate cache UI fixture failure'};
        entry.fixture = true;
        entry.response = response;
        if (callback) { queueMicrotask(() => callback(response)); return; }
        return Promise.resolve(response);
      }
      if (callback) {
        args[args.length - 1] = response => {entry.response = response; callback(response);};
        return original(...args);
      }
      const result = original(...args);
      if (result?.then) result.then(response => {entry.response = response;}, error => {entry.error = String(error);});
      return result;
    };
  });
  await opened.goto(report.optionsUrl, {waitUntil: 'domcontentloaded', timeout});
  await opened.locator(cardSelector).waitFor({state: 'visible', timeout});
  await opened.waitForFunction(() => document.querySelector('[data-cache-bytes]')?.textContent.includes('—') === false, null, {timeout});
  await activateExtensionTabWithoutForeground(context, opened, timeout);
  await assertBackground('open-options');
  return opened;
}
async function refresh() {
  await page.locator(cardSelector).getByRole('button', {name: '刷新', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('.translation-cache-metrics')?.getAttribute('aria-busy') === 'false');
}
async function expandLimits() {
  const details = page.locator('[data-cache-limits]');
  if (!await details.evaluate(element => element.open)) await details.locator('summary').click();
}
async function editLimits(sizeMiB, entries) {
  await expandLimits();
  await page.getByRole('spinbutton', {name: '容量上限（MiB）', exact: true}).fill(String(sizeMiB));
  await page.getByRole('spinbutton', {name: '条数上限', exact: true}).fill(String(entries));
  await page.getByRole('spinbutton', {name: '条数上限', exact: true}).blur();
}
async function saveLimits(sizeMiB, entries, quickClose = false) {
  await editLimits(sizeMiB, entries);
  const before = await readConfig();
  await page.evaluate(() => {window.__cacheMessages = [];});
  await page.locator(cardSelector).getByRole('button', {name: '保存', exact: true}).click();
  if (quickClose) {
    // The click starts the real persistConfig request before immediate page close.
    await page.waitForFunction(() => window.__cacheMessages.some(item => item.type === 'persistConfig'));
    report.lastQuickCloseMessages = await page.evaluate(() => window.__cacheMessages.filter(item => item.type === 'persistConfig'));
    await page.close();
    page = await openOptions();
  } else {
    await page.locator(cardSelector).getByRole('status').filter({hasText: '缓存设置已保存'}).waitFor({state: 'visible'});
  }
  const after = await readConfig();
  assert.equal(after.translationCacheMaxBytes, sizeMiB * MIB);
  assert.equal(after.translationCacheMaxEntries, entries);
  report.persistenceCases.push({quickClose, before: {
    bytes: before.translationCacheMaxBytes, entries: before.translationCacheMaxEntries,
  }, after: {bytes: after.translationCacheMaxBytes, entries: after.translationCacheMaxEntries}});
}
async function records() {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('FluentReadTranslationCache');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('entries', 'readonly');
      const all = tx.objectStore('entries').getAll();
      tx.oncomplete = () => {db.close(); resolve(all.result);};
      tx.onerror = () => {db.close(); reject(tx.error);};
    };
  }));
}
async function seedRecords(count, extraCharacters = 0) {
  return page.evaluate(({count, extraCharacters}) => new Promise((resolve, reject) => {
    const request = indexedDB.open('FluentReadTranslationCache');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(['entries', 'totals'], 'readwrite');
      const entries = tx.objectStore('entries');
      const now = Date.now();
      for (let index = 0; index < count; index += 1) {
        const key = `cache-settings-fixture-${String(index).padStart(4, '0')}`;
        const translation = `浏览器缓存管理样本 ${index}。${'字'.repeat(extraCharacters)}`;
        const byteSize = new TextEncoder().encode(key + translation).byteLength;
        entries.put({key, translation, byteSize, createdAt: now - 2000,
          lastAccessedAt: now - 1000 + index, expiresAt: now + 86_400_000});
      }
      // Exercise old-store metadata recovery through the real engine.
      tx.objectStore('totals').delete('totals');
      tx.oncomplete = () => {db.close(); resolve({count, schemaVersion: db.version});};
      tx.onerror = () => {db.close(); reject(tx.error);};
    };
  }), {count, extraCharacters});
}
async function installProviderFixture() {
  await worker.evaluate(() => {
    const original = globalThis.fetch.bind(globalThis);
    globalThis.__cacheProviderCalls = 0;
    globalThis.fetch = async (input, init) => {
      if (String(input).includes('/_/TranslateWebserverUi/data/batchexecute')) {
        globalThis.__cacheProviderCalls += 1;
        const request = JSON.parse(new URLSearchParams(init.body).get('f.req'));
        const source = JSON.parse(request[0][0][1])[0][0];
        const translated = `缓存验证译文：${source}`;
        const payload = [null, [[[null, null, null, null, null, [[translated]]]]]];
        return new Response(JSON.stringify([['wrb.fr', 'MkEWBc', JSON.stringify(payload)]]), {
          status: 200, headers: {'Content-Type': 'application/json'},
        });
      }
      return original(input, init);
    };
  });
}
const translationRequest = {
  origin: 'A reusable cache result for the browser regression.', serviceOverride: 'google',
  sourceLanguage: 'en', targetLanguage: 'zh-CN', enableAIContext: false,
};

(async () => {
  let primaryError;
  let launchAttempted = false;
  try {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-cache-settings-edge-'));
    report.profileDir = profileDir;
    launchAttempted = true;
    browserSession = await launchFocusSafePersistentContext({
      chromium, profileDir, browserPath: argument('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      background: true, headless: false, displayTarget: 'secondary', timeout,
      viewport: {width: 1280, height: 900}, browserArgs: [
        `--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`,
        '--no-first-run', '--no-default-browser-check',
      ],
    });
    guardBrowserClose(browserSession, profileDir);
    context = browserSession.context;
    report.launchMode = browserSession.launchMode;
    report.focusPolicy = browserSession.focusPolicy;
    report.windowPlacement = browserSession.windowPlacement;
    const cdp = await context.browser().newBrowserCDPSession();
    let cdpError;
    try {
      const {processInfo} = await cdp.send('SystemInfo.getProcessInfo');
      browserPid = processInfo.find(item => item.type === 'browser').id;
    } catch (error) {cdpError = error; throw error;}
    finally {
      try {await cdp.detach();} catch (error) {
        if (!cdpError) throw error;
        process.stderr.write(`CDP detach failed: ${error.stack || error}\n`);
      }
    }
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout});
    captureErrors(worker, 'service-worker');
    const extensionId = worker.url().match(/^chrome-extension:\/\/([^/]+)/)[1];
    report.optionsUrl = `chrome-extension://${extensionId}/${manifest.options_page || manifest.options_ui.page}#settings-advanced`;
    page = await openOptions();
    const initial = await stats();
    // 默认上限为 10 MiB / 10,000 条；无用量时按每条 1 KiB 估算，约 200 页。
    assert.deepEqual(initial, {bytes: 0, entries: 0, maxBytes: 10 * MIB, maxEntries: 10_000});
    assert.equal(await page.locator('[data-cache-limits]').evaluate(element => element.open), false);
    const navigationIds = await page.locator('nav[aria-label="设置分类"] button').evaluateAll(elements => elements.map(element => element.dataset.section));
    assert.deepEqual(navigationIds, expectedNavigationIds);
    report.navigationIds = navigationIds;
    const navigation = await page.locator('nav[aria-label="设置分类"] button').evaluateAll(elements => elements.map(element => ({text: element.textContent.trim(), attributes: Object.fromEntries([...element.attributes].map(a => [a.name, a.value]))})));
    assert.equal(navigation.length, expectedNavigationIds.length);
    assert.equal(navigation.some(item => item.text.includes('缓存')), false);
    assert.match(await page.locator('[data-cache-estimate]').innerText(), /10,000/u);
    assert.match(await page.locator('[data-cache-estimate]').innerText(), /200/u);
    record('default-limits-and-compact-existing-card', {stats: initial, navigationCount: navigation.length});
    await screenshot('cache-default-collapsed');

    await installProviderFixture();
    const translated = await message(translationRequest);
    assert.equal(translated, `缓存验证译文：${translationRequest.origin}`);
    const actualRecords = await records();
    assert.ok(actualRecords.length > 0, 'Real translation pipeline must persist a result');
    const actualKeys = actualRecords.map(item => item.key);
    assert.equal(await worker.evaluate(() => globalThis.__cacheProviderCalls), 1);
    assert.equal(await message(translationRequest), translated);
    assert.equal(await worker.evaluate(() => globalThis.__cacheProviderCalls), 1, 'Second translation should hit cache');
    record('runtime-provider-fixture-writes-and-cache-hit', {actualKeys, providerCalls: 1});
    await seedRecords(110);
    const seeded = await stats();
    assert.equal(seeded.entries, 110 + actualKeys.length);
    assert.equal(seeded.bytes, (await records()).reduce((sum, item) => sum + item.byteSize, 0));
    await refresh();
    assert.match(await page.locator('[data-cache-entries]').innerText(), new RegExp(`^${seeded.entries}\\s*/`));
    await screenshot('cache-usage-populated');
    record('real-indexeddb-fixture-stats', {stats: seeded});

    const beforeTouch = (await records()).filter(item => actualKeys.includes(item.key));
    assert.equal(await message(translationRequest), translated);
    await page.waitForFunction(previous => new Promise(resolve => {
      const request = indexedDB.open('FluentReadTranslationCache');
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('entries');
        const all = tx.objectStore('entries').getAll();
        tx.oncomplete = () => {db.close(); resolve(previous.every(old => all.result.some(item => item.key === old.key && item.lastAccessedAt > old.lastAccessedAt)));};
      };
    }), beforeTouch);
    await saveLimits(1, 100);
    const pruned = await stats();
    const survivors = await records();
    assert.equal(pruned.entries, 100);
    assert.ok(pruned.bytes <= MIB);
    assert.ok(actualKeys.every(key => survivors.some(item => item.key === key)), 'Recently used real translation must survive LRU');
    assert.equal(survivors.some(item => item.key === 'cache-settings-fixture-0000'), false);
    assert.equal(survivors.some(item => item.key === 'cache-settings-fixture-0109'), true);
    record('lower-limit-prunes-and-persistent-hot-read-lru', {beforeTouch, stats: pruned});
    await screenshot('cache-limits-pruned');
    await page.close();
    page = await openOptions();
    assert.equal((await readConfig()).translationCacheMaxEntries, 100);
    assert.match(await page.locator('[data-cache-entries]').innerText(), /^100\s*\/\s*100/u);
    report.crossPageSync = true;
    record('limits-and-usage-persist-after-reopen');
    await screenshot('cache-reopened');

    const toggle = page.locator(cardSelector).getByRole('switch', {name: '缓存翻译结果'});
    await toggle.locator('..').click();
    await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="缓存翻译结果"]')?.getAttribute('aria-checked') === 'false');
    await page.locator(cardSelector).getByRole('status').filter({hasText: '缓存设置已保存'}).waitFor();
    assert.equal((await readConfig()).useCache, false);
    await page.locator(cardSelector).getByRole('button', {name: '清空缓存', exact: true}).click();
    await page.locator(cardSelector).getByRole('status').filter({hasText: '翻译缓存已清空'}).waitFor();
    assert.equal((await stats()).entries, 0);
    await message({...translationRequest, origin: 'Disabled cache must skip writes.'});
    assert.equal((await stats()).entries, 0);
    await seedRecords(3);
    await refresh();
    assert.equal((await stats()).entries, 3);
    await page.locator(cardSelector).getByRole('button', {name: '清空缓存', exact: true}).click();
    await page.locator(cardSelector).getByRole('status').filter({hasText: '翻译缓存已清空'}).waitFor();
    assert.deepEqual(await stats(), {bytes: 0, entries: 0, maxBytes: MIB, maxEntries: 100});
    record('disabled-cache-remains-manageable-and-clear-is-real');
    await screenshot('cache-disabled-cleared');

    await saveLimits(2, 300, true);
    report.quickClose = true;
    await saveLimits(2, 400);
    await saveLimits(3, 500, true);
    report.latestWriteWins = true;
    record('quick-close-and-latest-write-persist');
    await screenshot('cache-quick-close-reopened');

    for (const [fault, action, expected] of [
      ['getTranslationCacheStats', '刷新', '暂时无法读取缓存用量'],
      ['clearTranslationCache', '清空缓存', '缓存未能确认清空'],
    ]) {
      await page.evaluate(fault => {window.__cacheFault = fault;}, fault);
      await page.locator(cardSelector).getByRole('button', {name: action, exact: true}).click();
      await page.locator(cardSelector).getByRole('alert').filter({hasText: expected}).waitFor();
      if (fault === 'getTranslationCacheStats') assert.match(await page.locator('[data-cache-bytes]').innerText(), /—/u);
      await screenshot(`cache-error-${fault}`);
      await page.evaluate(() => {window.__cacheFault = '';});
      await page.locator(cardSelector).getByRole('button', {name: action, exact: true}).click();
      await page.locator(cardSelector).getByRole('alert').waitFor({state: 'hidden'});
      record(`error-and-retry-${fault}`);
    }
    await editLimits(4, 600);
    await page.evaluate(() => {window.__cacheFault = 'persistConfig';});
    await page.locator(cardSelector).getByRole('button', {name: '保存', exact: true}).click();
    await page.locator(cardSelector).getByRole('alert').filter({hasText: '设置保存失败'}).waitFor();
    assert.equal((await readConfig()).translationCacheMaxEntries, 500);
    await screenshot('cache-error-save');
    await page.evaluate(() => {window.__cacheFault = '';});
    await saveLimits(4, 600);
    record('save-failure-rolls-back-and-retry-succeeds');

    await message({type: 'clearTranslationCache'});
    await seedRecords(45, 10_000);
    const beforeByteLimit = await stats();
    assert.equal(beforeByteLimit.entries, 45);
    assert.ok(beforeByteLimit.bytes > MIB && beforeByteLimit.bytes < 4 * MIB);
    await saveLimits(1, 600);
    const afterByteLimit = await stats();
    assert.ok(afterByteLimit.entries > 0 && afterByteLimit.entries < 45);
    assert.ok(afterByteLimit.bytes <= MIB);
    assert.equal((await records()).some(item => item.key === 'cache-settings-fixture-0044'), true);
    assert.equal((await records()).some(item => item.key === 'cache-settings-fixture-0000'), false);
    record('byte-limit-prunes-before-entry-limit', {before: beforeByteLimit, after: afterByteLimit});
    await screenshot('cache-byte-limit-pruned');

    await page.setViewportSize({width: 390, height: 844});
    await page.locator(cardSelector).scrollIntoViewIfNeeded();
    const layout = await page.evaluate(() => ({width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      card: document.querySelector('[data-translation-cache-settings]').getBoundingClientRect().toJSON()}));
    assert.ok(layout.scrollWidth <= layout.width, JSON.stringify(layout));
    assert.ok(layout.card.x >= 0 && layout.card.right <= layout.width, JSON.stringify(layout));
    record('390px-expanded-cache-card-no-horizontal-overflow', {layout});
    await screenshot('cache-narrow-390');
    await page.setViewportSize({width: 1280, height: 900});
    await page.emulateMedia({colorScheme: 'dark'});
    await screenshot('cache-dark');
    await assertBackground('completed');
    assert.equal(report.consoleErrors.length, 0, JSON.stringify(report.consoleErrors));
    assert.equal(report.windowPlacement.browserFrontmost, false);
    report.ok = true;
  } catch (error) {
    primaryError = error;
    report.errors.push({message: String(error), stack: error.stack});
    if (page && !page.isClosed()) await screenshot('cache-failure').catch(() => {});
    process.exitCode = 1;
  } finally {
    const cleanupErrors = [];
    const cleanup = async action => {
      try {await action();} catch (error) {cleanupErrors.push(error);}
    };
    let browserClosed = false;
    await cleanup(async () => {
      if (browserSession) {await browserSession.close(); browserClosed = true;}
    });
    await cleanup(() => {
      if (!profileDir) return;
      if (browserClosed) fs.rmSync(profileDir, {recursive: true, force: true});
      else if (!launchAttempted) {
        // No browser launch was attempted; only remove an empty initial profile.
        try {fs.rmdirSync(profileDir);} catch (error) {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
        }
      }
      report.cleanedTemporaryProfile = !fs.existsSync(profileDir);
    });
    if (cleanupErrors.length) {
      report.ok = false;
      report.cleanupErrors = cleanupErrors.map(error => error.stack || String(error));
    }
    await cleanup(() => {fs.writeFileSync(path.join(artifactsDir, 'summary.json'), JSON.stringify(report, null, 2));});
    for (const error of cleanupErrors) process.stderr.write(`Cleanup failed: ${error.stack || error}\n`);
    if (cleanupErrors.length && !primaryError) throw cleanupErrors[0];
    process.stdout.write(`${JSON.stringify({ok: report.ok, cases: report.caseCoverage.length, summary: path.join(artifactsDir, 'summary.json'), errors: report.errors}, null, 2)}\n`);
  }
})().catch(error => {process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1;});
