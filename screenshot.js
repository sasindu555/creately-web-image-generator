const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { chromium } = require('playwright');

const DEMO_BASE = 'https://creately.com/demo-start/?tempId=';
const SEARCH_API = 'https://community-api.creately.com/community/search/all/';

(async () => {
  const urlsFile = 'templates.txt';
  const urlsPath = path.resolve(urlsFile);
  if (!fs.existsSync(urlsPath)) {
    throw new Error(`URLs file not found: ${urlsPath}`);
  }

  const urls = fs
    .readFileSync(urlsPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (urls.length === 0) {
    throw new Error(`No URLs found in ${urlsPath}`);
  }

  const logPath = path.join('screenshots', 'capture-log.txt');

  const readline = require('readline');
  const ask = (question) =>
    new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    });

  const widthInput = await ask('Screenshot width (default 1280): ');
  const heightInput = await ask('Screenshot height (default 720): ');
  const formatInput = await ask('Screenshot format (png/jpeg/webp, default png): ');
  const templatePanel = await ask('Keep template panel open? (Y/n): ');
  const viewportWidth = Number.parseInt(widthInput, 10) || 1280;
  const viewportHeight = Number.parseInt(heightInput, 10) || 720;
  const formatRaw = (formatInput || '').trim().toLowerCase();
  const format = ['png', 'jpeg', 'webp'].includes(formatRaw) ? formatRaw : 'png';
  const userDataDir = path.resolve('browser-data');
  const parseYesNo = (value, defaultValue) => {
    const v = String(value || '').trim().toLowerCase();
    if (!v) return defaultValue;
    if (['y', 'yes', 'true', '1'].includes(v)) return true;
    if (['n', 'no', 'false', '0'].includes(v)) return false;
    return defaultValue;
  };
  const keepTemplatePanelOpen = parseYesNo(templatePanel, true);

  const resolveTargetUrl = async (raw) => {
    const trimmed = raw.trim();
    const commaIndex = trimmed.indexOf(',');
    const first = (commaIndex === -1 ? trimmed : trimmed.slice(0, commaIndex)).trim();
    let titleText = commaIndex === -1 ? '' : trimmed.slice(commaIndex + 1).trim();

    if (/^https?:\/\//i.test(first)) {
      return { targetUrl: first, source: first, titleText: titleText || '' };
    }

    if (!first) {
      return { targetUrl: null, source: '', templateId: null, titleText };
    }

    if (/^id:/i.test(first)) {
      const directId = first.slice(3).trim();
      if (!directId) {
        return { targetUrl: null, source: '', templateId: null, titleText };
      }
      return {
        targetUrl: `${DEMO_BASE}${directId}`,
        source: directId,
        templateId: directId,
        titleText,
      };
    }

    const term = first;
    if (!titleText) {
      titleText = term;
    }
    const query = new URL(SEARCH_API);
    query.searchParams.set('limit', '1');
    query.searchParams.set('offset', '0');
    query.searchParams.set('langCode', 'en');
    query.searchParams.set('term', term);

    const res = await fetch(query.toString(), { method: 'GET' });
    if (!res.ok) {
      throw new Error(`Search API failed (${res.status}) for term: ${term}`);
    }
    const data = await res.json();
    const id = data?.diagrams?.[0]?.id;
    if (!id) {
      return { targetUrl: null, source: term, templateId: null, titleText };
    }
    return { targetUrl: `${DEMO_BASE}${id}`, source: term, templateId: id, titleText };
  };

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--window-size=${viewportWidth},${viewportHeight}`],
    viewport: { width: viewportWidth, height: viewportHeight }
  });

  const page = context.pages()[0] || (await context.newPage());

  // 1️⃣ Manual login (once)
  await page.goto('https://creately.com/login/', {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });

  const safeGoto = async (url) => {
    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 120000,
      });
    } catch (err) {
      const msg = String(err && err.message);
      if (!msg.includes('interrupted by another navigation')) {
        throw err;
      }
    }
  };


  // Wait for user to finish login manually
  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Log in manually, then press Enter to continue...', () => {
      rl.close();
      resolve();
    });
  });

  const runStart = Date.now();
  let successCount = 0;
  let noTemplateCount = 0;
  let errorCount = 0;

  // 2️⃣ Visit each resolved URL and take a screenshot
  for (let i = 0; i < urls.length; i += 1) {
    const itemStart = Date.now();
    const { targetUrl, source, templateId: resolvedId, titleText } = await resolveTargetUrl(urls[i]);
    const currentLabel = titleText || source || 'unknown';
    console.log(`[${i + 1}/${urls.length}] ${currentLabel}`);
    if (!targetUrl) {
      const timestamp = new Date().toISOString();
      const elapsedMs = Date.now() - itemStart;
      fs.appendFileSync(logPath, `${timestamp}\t${source} | NO_TEMPLATE_FOUND\n`);
      console.log(`  status: no-template (${elapsedMs}ms)`);
      noTemplateCount += 1;
      continue;
    }

    try {
      await safeGoto(targetUrl);

    // Wait for page to settle before screenshot
    await page.waitForLoadState('domcontentloaded');
    await page.waitForLoadState('load');
    try {
      await page.waitForLoadState('networkidle', { timeout: 45000 });
    } catch {
      // Ignore if network never goes idle
    }
    await page.waitForTimeout(3000);

    if (!keepTemplatePanelOpen) {
      try {
        const templatePanelCloseButton = page.locator('#fab-container-btn');
        await templatePanelCloseButton.waitFor({ state: 'visible', timeout: 15000 });
        await templatePanelCloseButton.click();
        await page.waitForTimeout(500);
      } catch {
        // If the template panel isn't present or can't be closed, continue without failing
      }
    }

    // Update title text before screenshot (only if provided)
    if (titleText) {
      try {
        const titleLocator = page.locator('#workspace-title-label > div > div');
        await titleLocator.waitFor({ state: 'visible', timeout: 15000 });
        await titleLocator.evaluate((el, text) => {
          el.textContent = text;
        }, titleText);
        await page.waitForTimeout(1000);
      } catch {
        // If title element isn't available, continue without failing
      }
    }

    if (keepTemplatePanelOpen) {
      // Hover zoom control, click toolbar button, then drag canvas to compensate for panel space
      try {
        const zoomHoverTarget = page.locator(
          'body > app-root > ng-component > div.container-fluid > div.diagram-container.row > div.fx-pointer-events-none.fx-center-vertical.fx-cover.diagram-inner-container > div.base-right-content-area > div > div > div.diagram-viewport-floating-controls > div.diagram-viewport-floating-controls-right-area > div > diagram-toolbar > div > div.dt-block.dt-zoom'
        );
        await zoomHoverTarget.waitFor({ state: 'visible', timeout: 15000 });
        await zoomHoverTarget.hover();
        const zoomButton = zoomHoverTarget.locator('button');
        await zoomButton.first().click();
        await page.waitForTimeout(300);

        const panButton = page.locator(
          'body > app-root > ng-component > div.container-fluid > div.diagram-container.row > div.fx-pointer-events-none.fx-center-vertical.fx-cover.diagram-inner-container > div.base-right-content-area > div > div > div.diagram-viewport-floating-controls > div.diagram-viewport-floating-controls-right-area > div > diagram-toolbar > div > div:nth-child(3) > div:nth-child(2) > button'
        );
        await panButton.waitFor({ state: 'visible', timeout: 15000 });
        await panButton.click();

        const viewport = page.viewportSize() || { width: 1440, height: 900 };
        const startX = Math.floor(viewport.width / 2);
        const startY = Math.floor(viewport.height / 2);
        const endX = startX + 100;
        const endY = startY;

        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(endX, endY, { steps: 10 });
        await page.mouse.up();
        await page.waitForTimeout(1000);
      } catch {
        // If control isn't available, continue without failing
      }
    }

    let templateId = resolvedId || 'page';
    try {
      const parsed = new URL(targetUrl);
      templateId =
        parsed.searchParams.get('tempId') ||
        parsed.searchParams.get('templateId') ||
        templateId;
    } catch {
      templateId = 'page';
    }

    const filename = `${templateId}.${format}`;
    const outputPath = path.join('screenshots', filename);

    if (format === 'webp') {
      const tempPng = path.join('screenshots', `${templateId}.png`);
      await page.screenshot({
        path: tempPng,
        fullPage: false,
        type: 'png',
      });
      await sharp(tempPng).webp().toFile(outputPath);
      fs.unlinkSync(tempPng);
    } else {
      await page.screenshot({
        path: outputPath,
        fullPage: false,
        type: format,
      });
    }

    const timestamp = new Date().toISOString();
    fs.appendFileSync(logPath, `${timestamp}\t${source} | ${filename}\n`);
    const elapsedMs = Date.now() - itemStart;
    console.log(`  status: success (${elapsedMs}ms)`);
    successCount += 1;
    } catch (err) {
      const elapsedMs = Date.now() - itemStart;
      console.log(`  status: error (${elapsedMs}ms) ${err && err.message ? err.message : err}`);
      errorCount += 1;
    }
  }

  const totalMs = Date.now() - runStart;
  console.log(`Summary: ${successCount} success, ${noTemplateCount} no-template, ${errorCount} errors, ${totalMs}ms total`);

  await context.close();
})();
