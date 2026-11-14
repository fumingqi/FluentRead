#!/usr/bin/env node
// 回答风格预览专项：真实生产扩展、独立后台 Edge，只验证左侧预览与右侧设置的响应式布局和实时更新，不调用模型或外部服务。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index < 0 ? fallback : process.argv[index + 1]; };
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-settings-preview-writing'));
const suites = arg('suite', 'writing').split(',');
assert(suites.every(suite => suite === 'writing'), 'suite must be writing');
const {chromium} = require(path.join(arg('playwright-root'), 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground} = require(arg('focus-safe-helper'));
const report = {ok: false, extensionDir, cases: [], screenshots: [], layout: [], consoleErrors: []};

(async () => {
  fs.mkdirSync(artifactsDir, {recursive: true});
  let profileDir; let launchAttempted = false;
  let launched;
  let page;
  try {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-preview-about-edge-'));
  launchAttempted = true;
    launched = await launchFocusSafePersistentContext({chromium, profileDir, browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', background: true, headless: false, viewport: {width: 1440, height: 1000}, timeout: 30000, browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']});
    Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
    assert.equal(report.launchMode, 'macos-background-cdp');
    assert.equal(report.windowPlacement.browserFrontmost, false);
    const context = launched.context;
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: 30000});
    const origin = worker.url().split('/').slice(0, 3).join('/');
    page = await newPageWithoutForeground(context, 30000);
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => report.consoleErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    const patch = async changes => {
      const response = await page.evaluate(async changes => {
        const read = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
        if (!read.success) throw Error(read.error);
        const config = typeof read.value === 'string' ? JSON.parse(read.value) : read.value;
        return chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: changes, expected: Object.fromEntries(Object.keys(changes).map(key => [key, config[key]])), clientId: `preview-writing-${crypto.randomUUID()}`, sequence: 1});
      }, changes);
      assert.equal(response.success, true, response.error);
    };
    const shot = async name => {
      await page.locator('.settings-app').evaluate(async root => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await Promise.all(root.getAnimations({subtree: true}).filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
      });
      const file = path.join(artifactsDir, `${name}.png`);
      await page.screenshot({path: file}); report.screenshots.push(file);
    };
    {
      await page.goto(`${origin}/options.html#settings-writing`);
      await page.locator('.writing-settings').waitFor();
      await patch({uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, animations: false, theme: 'light'});
      await page.reload();
      const choices = page.locator('.writing-style-controls');
      const sample = page.locator('.style-preview');
      for (const width of [1440, 1024, 820, 390]) {
        await page.setViewportSize({width, height: 1000});
        await page.locator('.writing-default-style').scrollIntoViewIfNeeded();
        const settingsBox = await choices.boundingBox(); const previewBox = await sample.boundingBox();
        assert(settingsBox && previewBox);
        if (width > 1100) {
          assert(previewBox.x + previewBox.width < settingsBox.x, 'preview is on the left');
          assert(Math.abs(previewBox.y - settingsBox.y) < 2, 'columns align at the top');
          assert(settingsBox.width >= previewBox.width, 'choices retain their wider column');
        } else assert(previewBox.y + previewBox.height < settingsBox.y, 'preview precedes settings on narrow screens');
        assert(await page.locator('.writing-settings').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        report.layout.push({width, previewBox, settingsBox});
        await shot(`writing-${width}`);
      }
      await page.setViewportSize({width: 1440, height: 1000});
      const before = await sample.locator('.preview-body').innerText();
      await choices.getByRole('radiogroup', {name: '您的角色', exact: true}).getByRole('radio', {name: '维护者', exact: true}).click();
      await page.waitForFunction(previous => document.querySelector('.style-preview .preview-body')?.textContent.trim() !== previous, before);
      assert.notEqual(await sample.locator('.preview-body').innerText(), before);
      report.cases.push('left-preview-right-settings, narrow stacking and live preview');
    }

    assert.equal(report.consoleErrors.length, 0, JSON.stringify(report.consoleErrors));
    report.ok = true;
  } catch (error) {
    report.error = error.stack;
    if (page && !page.isClosed()) await page.screenshot({path: path.join(artifactsDir, 'failure.png')}).catch(() => {});
    process.exitCode = 1;
  } finally {
    report.cleanupErrors = [];
    let closed = !launchAttempted;
    if (launched) {
      try {await launched.close(); closed = true;}
      catch (error) {report.cleanupErrors.push(`session close: ${error.message}`);}
    }
    if (profileDir) {
      if (closed) {
        try {fs.rmSync(profileDir, {recursive: true, force: true});}
        catch (error) {report.cleanupErrors.push(`profile removal: ${error.message}`); report.retainedProfile = profileDir;}
      } else report.retainedProfile = profileDir;
    }
    if (report.cleanupErrors.length) {report.ok = false; if ('status' in report) report.status = 'failed'; process.exitCode = 1;}
    try {fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));}
    catch (error) {console.error(error.stack || error); process.exitCode = 1;}

    console.log(JSON.stringify(report, null, 2));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
