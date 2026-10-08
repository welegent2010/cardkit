/* Regenerates assets/img/hero-editor.jpg, the home hero shot.
 *
 *   tests/hero-shot.js
 *
 * It opens the real CSS Code Editor, pastes a demo code block, renders it,
 * clears the right-hand panel and the sticky action bar out of the way, then
 * screenshots the paste box and the rendered result at 2x. The PNG is
 * converted to a 1440px wide JPEG with sips, because a 175 KB hero is worth
 * having over a 790 KB one.
 *
 * Needs a network connection: the demo card uses a stock photo, and the
 * screenshot is worthless if the photo is a broken image icon.
 *
 * Dev only. It is not part of run-all.sh.
 */

const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const OUT_JPG = path.join(ROOT, "assets", "img", "hero-editor.jpg");
const TMP_PNG = path.join(ROOT, "output", "hero-editor-raw.png");

/* The demo block. Deliberately a plain Squarespace-style card: a photo, a
   heading, a line of copy, a meta line and a button. Nothing platform
   specific, nothing that needs a library. */
const DEMO = [
  "<style>",
  "  .page { background: #F4F1EA; padding: 44px; }",
  "  .visit { display: grid; grid-template-columns: 340px 1fr; max-width: 900px; margin: 0 auto; background: #fff; border: 1px solid #E5E7EB; border-radius: 16px; overflow: hidden; }",
  "  .visit img { display: block; width: 100%; height: 360px; object-fit: cover; }",
  "  .visit-body { padding: 34px 38px; }",
  "  .visit h3 { margin: 0 0 10px; font: 600 28px/1.2 Georgia, serif; color: #16233A; }",
  "  .visit p { margin: 0 0 14px; color: #5C5548; font-size: 15px; line-height: 1.65; }",
  "  .visit .meta { margin: 0 0 26px; color: #8A7F6D; font-size: 12px; letter-spacing: .1em; text-transform: uppercase; }",
  "  .visit a { display: inline-block; padding: 13px 22px; background: #16233A; color: #F4F1EA; font-size: 13px; letter-spacing: .12em; }",
  "</style>",
  '<section class="page">',
  '  <div class="visit">',
  '    <img src="https://images.unsplash.com/photo-1552053831-71594a27632d?w=680" alt="">',
  '    <div class="visit-body">',
  "      <h3>Walks, every Saturday</h3>",
  "      <p>GPS-tracked walks with a photo and a short note after every visit.</p>",
  '      <p class="meta">\u00a318 per walk &middot; 60 minutes &middot; one dog at a time</p>',
  '      <a href="#">Book a walk</a>',
  "    </div>",
  "  </div>",
  "</section>",
].join("\n");

(async () => {
  fs.mkdirSync(path.dirname(TMP_PNG), { recursive: true });
  fs.mkdirSync(path.dirname(OUT_JPG), { recursive: true });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1400 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.goto(pathToFileURL(path.join(ROOT, "tools", "css-code-editor", "index.html")).href);

  await page.evaluate(() => {
    document.getElementById("src").rows = 9;
    document.querySelector(".is-output").style.display = "none";
    document.querySelector("aside").style.display = "none";
    document.querySelector(".grid").style.gridTemplateColumns = "1fr";
  });

  await page.fill("#src", DEMO);
  await page.click("#btnRender");
  await page.waitForTimeout(3500);
  await page.evaluate(() => { document.getElementById("src").scrollTop = 0; });
  await page.waitForTimeout(200);

  const cut = await page.evaluate(() => {
    const paste = document.getElementById("src").closest(".box").getBoundingClientRect();
    const frame = document.getElementById("framewrap").getBoundingClientRect();
    return {
      x: Math.round(paste.left),
      y: Math.round(paste.top),
      width: Math.round(paste.width),
      height: Math.round(frame.bottom - paste.top + 2),
    };
  });

  await page.screenshot({ path: TMP_PNG, clip: cut });
  await browser.close();

  execFileSync("sips", [
    "--resampleWidth", "1440",
    "-s", "format", "jpeg",
    "-s", "formatOptions", "86",
    TMP_PNG,
    "--out", OUT_JPG,
  ], { stdio: "ignore" });
  fs.unlinkSync(TMP_PNG);

  const kb = Math.round(fs.statSync(OUT_JPG).size / 1024);
  console.log(`hero-editor.jpg written: ${cut.width}x${cut.height} CSS px at 2x, 1440 wide, ${kb} KB`);
})().catch((e) => { console.error("HERO SHOT FAILED", e); process.exit(1); });
