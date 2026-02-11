const fs = require('fs');
const path = require('path');
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
  const viewportWidth = Number.parseInt(widthInput, 10) || 1280;
  const viewportHeight = Number.parseInt(heightInput, 10) || 720;

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

  const browser = await chromium.launch({
    headless: false,
    args: [`--window-size=${viewportWidth},${viewportHeight}`],
  });

  const context = await browser.newContext({
    viewport: { width: viewportWidth, height: viewportHeight },
  });

  const page = await context.newPage();

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

  // 2️⃣ Visit each resolved URL and take a screenshot
  for (let i = 0; i < urls.length; i += 1) {
    const { targetUrl, source, templateId: resolvedId, titleText } = await resolveTargetUrl(urls[i]);
    if (!targetUrl) {
      const timestamp = new Date().toISOString();
      fs.appendFileSync(logPath, `${timestamp}\t${source}\tNO_TEMPLATE_FOUND\n`);
      continue;
    }

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

    // Hover zoom control, click toolbar button, then drag canvas 260px to the right
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

    const filename = `${templateId}.png`;

    await page.screenshot({
      path: path.join('screenshots', filename),
      fullPage: false,
    });

    const timestamp = new Date().toISOString();
    fs.appendFileSync(logPath, `${timestamp}\t${source}\t${targetUrl}\t${filename}\n`);
  }

  await context.close();
  await browser.close();
})();
