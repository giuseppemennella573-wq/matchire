// Renders index.html at 30 fps, frame by frame, straight into ffmpeg (no frame dumps on disk).
// node render.cjs out/silent.mp4
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const FPS = 30;
(async () => {
  const outFile = path.resolve(process.argv[2] || path.join(__dirname, "out", "silent.mp4"));
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  await p.goto("file://" + path.join(__dirname, "index.html"));
  await p.evaluate(() => document.fonts.ready);
  const duration = await p.evaluate(() => window.DURATION);
  const ff = spawn("ffmpeg", ["-v", "error", "-y", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "png", "-i", "-",
    "-c:v", "libx264", "-preset", "slow", "-crf", "24", "-pix_fmt", "yuv420p", "-r", String(FPS), outFile], { stdio: ["pipe", "inherit", "inherit"] });
  const frames = Math.round(duration * FPS);
  for (let i = 0; i < frames; i++) {
    await p.evaluate((t) => render(t), i / FPS);
    const png = await p.screenshot({ type: "png" });
    if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once("drain", r));
    if (i % 150 === 0) process.stdout.write(`frame ${i}/${frames}\n`);
  }
  ff.stdin.end();
  await new Promise((r, j) => ff.on("close", (c) => (c ? j(new Error("ffmpeg failed")) : r())));
  await b.close();
  console.log(`rendered ${frames} frames (${duration}s) to ${outFile}`);
})();
