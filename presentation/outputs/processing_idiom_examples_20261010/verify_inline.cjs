const { chromium } = require('/Users/chihun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 860, height: 1100 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('file:///Users/chihun/Documents/ChatGPT/HOP_pptdata/outputs/processing_idiom_examples_20261010/browser_preview.html');
    const frame = page.frameLocator('iframe');
    await frame.locator('#idiom-chart svg').waitFor();
    const initial = await frame.locator('#idiom-selection').innerText();
    if (!initial.includes('죽이') || !initial.includes('어휘 밖')) throw new Error('Initial OOV state failed');
    await frame.locator('button[data-term="되든"]').first().click();
    const repeated = await frame.locator('#idiom-selection').innerText();
    if (!repeated.includes('2회') || !repeated.includes('0.7860')) throw new Error('Repeated-word selection failed');
    await frame.locator('button[data-term="밥이"]').click();
    const outside = await frame.locator('#idiom-selection').innerText();
    if (!outside.includes('밥이') || !outside.includes('어휘 밖')) throw new Error('OOV selection failed');
    const responsive = [];
    for (const width of [736, 320]) {
      await page.setViewportSize({ width, height: 1250 });
      const layout = await frame.locator('#idiom-processed-data').evaluate(root => ({
        client: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
        bars: root.querySelectorAll('#idiom-chart rect[data-tooltip]').length,
        svgWidth: root.querySelector('#idiom-chart svg').getBoundingClientRect().width,
      }));
      if (layout.scroll > layout.client + 1 || layout.bars !== 5 || layout.svgWidth < 1) throw new Error('Layout failed ' + JSON.stringify(layout));
      await page.screenshot({ path: __dirname + '/preview_' + width + '.png', fullPage: true });
      responsive.push({ width, ...layout });
    }
    if (errors.length) throw new Error(errors.join('\n'));
    const result = { initial_oov: initial, repeated_word: repeated, selected_oov: outside, responsive, page_errors: errors };
    fs.writeFileSync(__dirname + '/visual_verification.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error.message); process.exit(1); });
