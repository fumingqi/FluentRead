'use strict';
const {guardBrowserClose} = require('./owned-browser-close.cjs');
// 设置页视口回归：真实生产扩展，验证外层不滚动、长表单底部与窄屏菜单可达。
const fs = require('node:fs');
const path = require('node:path');
function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-settings-viewport'));
const {chromium} = require(path.join(arg('playwright-root', '/Users/thinkstu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground} = require(arg('focus-safe-helper', path.join(__dirname, 'focus-safe-browser.cjs')));
const assert = (value, message) => { if (!value) throw new Error(message); };
const timeout = 30000;
fs.mkdirSync(artifactsDir, {recursive: true});

async function main() {
  const profileDir = fs.mkdtempSync('/private/tmp/fr-settings-viewport-');
  const report = {ok: false, extensionDir, cases: [], screenshots: [], consoleErrors: []};
  let launched, primaryError;
  let launchAttempted = false;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
    report.manifest = {options: manifest.options_page || manifest.options_ui?.page, popup: manifest.action?.default_popup};
    launchAttempted = true;
    launched = await launchFocusSafePersistentContext({
      chromium, profileDir, timeout, background: true, headless: false,
      browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      displayTarget: arg('display', 'secondary'), viewport: {width: 1440, height: 900},
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check'],
    });
    guardBrowserClose(launched, profileDir);
    Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
    const context = launched.context;
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout});
    const page = await newPageWithoutForeground(context, timeout);
    page.on('pageerror', error => report.consoleErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    const url = `chrome-extension://${new URL(worker.url()).host}/${report.manifest.options}`;
    async function settled() { await page.waitForTimeout(250); }
    async function shot(name) {
      const target = path.join(artifactsDir, `${name}.png`);
      await page.screenshot({path: target});
      report.screenshots.push(target);
    }
    async function check(name, screenshot = false) {
      await settled();
      const state = await page.evaluate(() => {
        const rect = selector => {
          const e = document.querySelector(selector), r = e.getBoundingClientRect();
          return {top: r.top, bottom: r.bottom, left: r.left, right: r.right, scrollTop: e.scrollTop, scrollLeft: e.scrollLeft, scrollHeight: e.scrollHeight, clientHeight: e.clientHeight};
        };
        return {scrollX, scrollY, width: innerWidth, height: innerHeight, documentHeight: document.documentElement.scrollHeight, documentWidth: document.documentElement.scrollWidth,
          shell: rect('.settings-app'), brand: rect('.brand'), topbar: rect('.topbar'), workspace: rect('.workspace'), content: rect('.settings-card'), nav: rect('nav')};
      });
      report.cases.push({name, state});
      assert(state.scrollY === 0 && state.scrollX === 0, `${name}: 外层文档发生滚动`);
      assert(state.documentHeight <= state.height + 1 && state.documentWidth <= state.width + 1, `${name}: 文档超出视口`);
      assert(state.shell.scrollTop === 0 && state.workspace.scrollTop === 0, `${name}: 布局容器被程序滚动`);
      assert(state.brand.top >= 0 && state.topbar.top >= state.workspace.top && state.topbar.bottom <= state.content.top + 1, `${name}: 品牌或标题被裁切`);
      assert(Math.abs(state.shell.bottom - state.height) < 1 && Math.abs(state.workspace.bottom - state.height) < 1, `${name}: 底部出现整页空白`);
      assert(state.content.bottom <= state.height && state.content.bottom >= state.height - 28, `${name}: 内容区未铺满可用高度`);
      if (screenshot) await shot(name);
    }
    async function navigate(id) {
      await page.locator(`nav button[data-section="${id}"]`).click();
      await settled();
      assert(await page.locator('.settings-card').evaluate(e => e.scrollTop <= 2), `${id}: 切换菜单未回到内容顶部`);
    }
    async function bottom(name) {
      const content = page.locator('.settings-card');
      await content.evaluate(e => e.scrollTo({top: e.scrollHeight, behavior: 'instant'}));
      await settled();
      const end = await content.evaluate(e => {
        const sections = [...e.querySelectorAll('.settings-section')].filter(s => s.getBoundingClientRect().height > 0);
        const last = sections.at(-1);
        return {remaining: e.scrollHeight - e.clientHeight - e.scrollTop, end: last?.getBoundingClientRect().bottom, bottom: e.getBoundingClientRect().bottom, scrollTop: e.scrollTop};
      });
      assert(end.scrollTop > 0 && Math.abs(end.remaining) <= 1 && end.end <= end.bottom + 1, `${name}: 长表单底部不可达 ${JSON.stringify(end)}`);
      await check(name, true);
    }
    await page.goto(url, {waitUntil: 'domcontentloaded'});
    await page.locator('#settings-general .el-switch').waitFor();
    await check('initial-general', true);
    await bottom('general-bottom');
    await page.locator('.search-box input').fill('软件语言');
    await page.locator('.search-results button').first().click();
    await check('language-search', true);
    await page.locator('[data-testid="ui-language-select"] .el-select__wrapper').click();
    await page.locator('[role="option"]:visible').first().waitFor();
    await check('language-menu', true);
    await page.keyboard.press('Escape');
    // 原生锚点滚动和 focus 都会遍历祖先；不能让隐藏溢出的页面壳成为第二个滚动区。
    await page.locator('#settings-general .el-switch').evaluate(e => e.scrollIntoView({block: 'start'}));
    await check('native-scroll-into-view');
    const ids = await page.locator('nav button').evaluateAll(nodes => nodes.map(n => n.dataset.section));
    for (const id of ids) {
      await navigate(id);
      await check(`navigation-${id}`);
    }
    await navigate('settings-video');
    await check('video-top', true);
    await bottom('video-bottom');
    await page.reload();
    await page.locator('#settings-video').waitFor();
    await check('video-deep-link-reload', true);
    for (const [width, height] of [[1024, 700], [820, 600], [390, 720], [1440, 480]]) {
      await page.setViewportSize({width, height});
      await navigate('settings-data');
      await check(`viewport-${width}-last-menu`);
      const visible = await page.locator('nav button.active').evaluate(e => {
        const r = e.getBoundingClientRect(), n = e.closest('nav').getBoundingClientRect();
        return r.top >= n.top - 1 && r.bottom <= n.bottom + 1 && r.left >= n.left - 1 && r.right <= n.right + 1;
      });
      assert(visible, `${width}: 当前菜单不可见`);
      await navigate('settings-video');
      await bottom(`video-bottom-${width}`);
      await navigate('settings-general');
      await check(`general-${width}`, true);
    }
    await page.setViewportSize({width: 1440, height: 900});
    const saved = await page.evaluate(() => chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'}));
    assert(saved?.success && saved.value, '无法读取临时配置');
    const response = await page.evaluate(config => chrome.runtime.sendMessage({type: 'persistConfig', mode: 'replace', config}), {...saved.value, theme: 'dark'});
    assert(response?.success, '无法切换临时配置主题');
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
    await check('general-dark', true);
    await navigate('settings-video');
    await bottom('video-dark-bottom');
    assert(report.consoleErrors.length === 0, '浏览器控制台存在异常');
    report.ok = true;
  } catch (error) {
    primaryError = error;
    report.error = error.stack || String(error);
  } finally {
    const cleanupErrors = [];
    const cleanup = async (resource, release) => {
      try { await release(); } catch (error) {
        cleanupErrors.push(error);
        (report.cleanupErrors ||= []).push({resource, error: String(error.stack || error)});
        report.ok = false;
        process.exitCode = 1;
        console.error(`Cleanup failed (${resource}):`, error);
      }
    };
    let browserClosed = false;
    await cleanup('browser', async () => { if (launched) { await launched.close(); browserClosed = true; } });
    await cleanup('profile', () => {
      if (!profileDir) return;
      if (browserClosed) fs.rmSync(profileDir, {recursive: true, force: true});
      else if (!launchAttempted) {
        try { fs.rmdirSync(profileDir); } catch (error) {
          // 未尝试启动浏览器时，仅移除初始空目录。
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
        }
      }
    });
    await cleanup('report', () => { fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2)); });
    if (cleanupErrors.length && !primaryError) throw cleanupErrors[0];
  }
  console.log(JSON.stringify({ok: report.ok, cases: report.cases.length, error: report.error, artifactsDir}));
  if (!report.ok) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
