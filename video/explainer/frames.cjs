// Stills for checking a scene: node frames.cjs 2 12.5 30  →  out/still-2.png, out/still-12.5.png …
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
(async () => {
  const out = path.join(__dirname, "out");
  fs.mkdirSync(out, { recursive: true });
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  await p.goto("file://" + path.join(__dirname, "index.html"));
  await p.evaluate(() => document.fonts.ready);
  for (const t of process.argv.slice(2).map(Number)) {
    await p.evaluate((t) => render(t), t);
    await p.screenshot({ path: path.join(out, `still-${t}.png`) });
  }
  await b.close();
})();
