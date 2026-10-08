/* CardKit smoke test.
   Run: tests/run-all.sh
   Covers both tools end to end: render, edit, export, and the two
   invariants that break silently (marker leakage, canvas taint). */

const fs = require("fs");
const path = require("path");
const http = require("http");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const FIXTURE = path.join(__dirname, "_fixture-source.png");
const FIXTURE2 = path.join(__dirname, "_fixture-wide.png");

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  -> " + extra : "")); }
};

/* The browser console also reports failed fetches for the stock images in the
   demo snippets. That is the network talking, not the tool, and this suite has
   to give the same answer with the cable out. */
const NET_NOISE = /Failed to load resource|net::ERR_/i;
const watch = (page, errors) => {
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && !NET_NOISE.test(m.text())) errors.push(m.text()); });
};

async function makeFixture(browser) {
  if (fs.existsSync(FIXTURE) && fs.existsSync(FIXTURE2)) return;
  const p = await browser.newPage();
  await p.setContent("<canvas id=c></canvas>");
  const make = (w, h, color) => p.evaluate(([w, h, color]) => {
    const c = document.getElementById("c");
    c.width = w; c.height = h;
    const x = c.getContext("2d");
    x.fillStyle = color; x.fillRect(0, 0, w, h);
    x.fillStyle = "#ffffff"; x.fillRect(Math.round(w * 0.2), Math.round(h * 0.2), Math.round(w * 0.5), Math.round(h * 0.5));
    return c.toDataURL("image/png");
  }, [w, h, color]);
  fs.writeFileSync(FIXTURE, Buffer.from((await make(920, 1280, "#B3402F")).split(",")[1], "base64"));
  fs.writeFileSync(FIXTURE2, Buffer.from((await make(1600, 900, "#2F5FB3")).split(",")[1], "base64"));
  await p.close();
}

(async () => {
  const browser = await chromium.launch();
  await makeFixture(browser);

  /* ---------------- cropper ---------------- */
  console.log("\nimage-canvas-padder");
  {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
    const page = await ctx.newPage();
    const errors = [];
    watch(page, errors);

    await page.goto(pathToFileURL(path.join(ROOT, "tools", "image-canvas-padder", "index.html")).href);

    ok("no files -> empty state visible", await page.locator("#empty").isVisible());

    await page.setInputFiles("#fileSrc", [FIXTURE]);
    await page.waitForFunction(() => /920 x 1280/.test(document.getElementById("pillSrc").textContent), null, { timeout: 5000 });
    ok("source dims reported", /920 x 1280/.test(await page.locator("#pillSrc").textContent()));
    ok("default preset is 1000 x 1500", (await page.locator("#pillTarget").textContent()).indexOf("1000 x 1500") >= 0);
    ok("no upscale badge at default", await page.locator("#pillUp").isHidden());

    /* 920x1280 into 1000x1500 must be centred at 100%, never stretched */
    const zoomPill = await page.locator("#pillZoom").textContent();
    ok("placement is 100% (native size, padded)", zoomPill.trim() === "100%", zoomPill);

    /* ---------------- the image can be resized by hand ---------------- */
    const setRange = (id, v) => page.evaluate(([id2, v2]) => {
      const el = document.getElementById(String(id2).replace(/^#/, ""));
      el.value = v2;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, [id, v]);

    await setRange("#sldW", "60");
    await page.waitForTimeout(150);
    ok("width slider drives the width", /60% · 552px/.test(await page.locator("#wVal").textContent()), await page.locator("#wVal").textContent());
    ok("shape lock keeps the height in step", /60% · 768px/.test(await page.locator("#hVal").textContent()), await page.locator("#hVal").textContent());

    await page.click("#cbxLock");
    await setRange("#sldH", "120");
    await page.waitForTimeout(150);
    ok("lock off lets the shape stretch", /120% · 1536px/.test(await page.locator("#hVal").textContent()), await page.locator("#hVal").textContent());
    ok("width is left alone while stretching", /552px/.test(await page.locator("#wVal").textContent()));
    ok("the stretch is called out", /stretched/.test(await page.locator("#sizeNote").textContent()));
    ok("upscaling one side raises the badge", await page.locator("#pillUp").isVisible());

    await page.click("#cbxLock");
    await page.click("#btn100");
    await page.waitForTimeout(150);
    ok("100% is the native pixel size",
      /100% · 920px/.test(await page.locator("#wVal").textContent()) &&
      /100% · 1280px/.test(await page.locator("#hVal").textContent()));

    await page.click("#btnFitW");
    await page.waitForTimeout(150);
    ok("FIT W spans the canvas width", /1000px/.test(await page.locator("#wVal").textContent()), await page.locator("#wVal").textContent());
    await page.click("#btnReset1");
    await page.waitForTimeout(150);
    ok("reset placement is back to 100%", (await page.locator("#pillZoom").textContent()).trim() === "100%");

    /* switch preset */
    await page.locator('.preset[data-i="1"]').click();
    ok("preset switch -> 1080 x 1080", (await page.locator("#pillTarget").textContent()).indexOf("1080 x 1080") >= 0);

    /* preview modal must show the exact export size */
    await page.click("#btnPreview");
    await page.waitForSelector("#mask:not([hidden])", { timeout: 3000 });
    await page.waitForFunction(() => /1080 x 1080/.test(document.getElementById("pvMeta").textContent), null, { timeout: 5000 });
    ok("preview reports 1080 x 1080", /1080 x 1080/.test(await page.locator("#pvMeta").textContent()));
    ok("preview image is a real bitmap", /^(data:image|blob:)/.test(await page.locator("#pvBody img").getAttribute("src")));
    await page.click("#btnPvClose");

    /* canvas is not tainted: toBlob must produce bytes */
    const blobOk = await page.evaluate(async () => {
      const c = document.createElement("canvas");
      c.width = 100; c.height = 100;
      const src = document.getElementById("laySrc");
      const x = c.getContext("2d");
      x.drawImage(src, 0, 0, 100, 100);
      try { await new Promise(r => c.toBlob(r, "image/jpeg", 0.9)); return true; }
      catch (e) { return false; }
    });
    ok("canvas export is not tainted", blobOk);

    /* download single */
    {
      const dl = page.waitForEvent("download", { timeout: 15000 });
      await page.click("#btnOne");
      const d = await dl;
      const name = d.suggestedFilename();
      ok("single download named with target size", /-1080x1080\.jpg$/.test(name), name);
      const out = path.join(ROOT, "output", name);
      await d.saveAs(out);
      const st = fs.statSync(out);
      ok("single file has bytes", st.size > 2000, st.size + " bytes");
      ok("single file is a JPEG", fs.readFileSync(out).slice(0, 3).toString("hex") === "ffd8ff");
    }

    /* batch zip with a second image */
    await page.setInputFiles("#fileSrc", [FIXTURE2]);
    await page.waitForFunction(() => document.querySelectorAll("#strip .thumb").length === 2, null, { timeout: 8000 });
    await page.click("#cbxBatch");
    {
      const dl = page.waitForEvent("download", { timeout: 20000 });
      await page.click("#btnZip");
      const d = await dl;
      const name = d.suggestedFilename();
      ok("batch download is a zip", /\.zip$/.test(name), name);
      const out = path.join(ROOT, "output", name);
      await d.saveAs(out);
      const buf = fs.readFileSync(out);
      ok("zip starts with PK", buf.slice(0, 2).toString() === "PK");
      ok("zip is not empty", buf.length > 4000, buf.length + " bytes");
      ok("zip end of central directory present", buf.slice(-22, -18).toString("hex") === "504b0506");
    }

    /* backdrop colour reaches the canvas */
    await page.fill("#colHex", "#123456");
    await page.dispatchEvent("#colHex", "change");
    const painted = await page.evaluate(() => document.getElementById("layBg").style.backgroundColor);
    ok("custom backdrop colour applied", /18, 52, 86|123456/.test(painted), painted);

    /* ---------------- the size list is the user's own ---------------- */
    const baseRows = await page.locator("#presetBox .prow").count();
    ok("shipped sizes are present", baseRows >= 7, baseRows + " rows");

    await page.click('.rt[data-r="16:9"]');
    await page.fill("#pzW", "1920");
    await page.waitForTimeout(150);
    ok("ratio lock drives the height", (await page.inputValue("#pzH")) === "1080", await page.inputValue("#pzH"));
    await page.fill("#pzH", "1440");
    await page.waitForTimeout(150);
    ok("and the width follows the height", (await page.inputValue("#pzW")) === "2560", await page.inputValue("#pzW"));

    await page.click('.rt[data-r="custom"]');
    await page.fill("#pzH", "741");
    await page.waitForTimeout(150);
    ok("CUSTOM leaves both numbers alone",
      (await page.inputValue("#pzW")) === "2560" && (await page.inputValue("#pzH")) === "741",
      (await page.inputValue("#pzW")) + " x " + (await page.inputValue("#pzH")));

    await page.fill("#pzW", "1920");
    await page.fill("#pzH", "1080");
    await page.waitForTimeout(150);
    await page.fill("#pzName", "Hero 16:9");
    await page.click("#btnAddPz");
    await page.waitForTimeout(250);
    ok("custom size is added", (await page.locator("#presetBox .prow").count()) === baseRows + 1);
    ok("custom size becomes the canvas", (await page.locator("#pillTarget").textContent()).indexOf("1920 x 1080") >= 0);
    ok("custom size shows its ratio", /16:9/.test(await page.locator("#presetBox .preset").last().textContent()));

    /* a size that is not one of the canned ratios is still legal */
    await page.fill("#pzName", "Odd panel");
    await page.fill("#pzW", "1280");
    await page.fill("#pzH", "741");
    await page.click("#btnAddPz");
    await page.waitForTimeout(200);
    ok("any width and height is accepted", (await page.locator("#pillTarget").textContent()).indexOf("1280 x 741") >= 0);

    /* the list is remembered in this browser */
    await page.reload();
    await page.waitForTimeout(400);
    ok("custom sizes survive a reload", (await page.locator("#presetBox .prow").count()) === baseRows + 2);
    ok("the selected size survives too", (await page.locator("#pillTarget").textContent()).indexOf("1280 x 741") >= 0);

    /* a custom size really is the export canvas */
    await page.click('#presetBox .preset:has-text("Hero 16:9")');
    await page.waitForTimeout(200);
    await page.setInputFiles("#fileSrc", [FIXTURE2]);
    await page.waitForFunction(() => /1600 x 900/.test(document.getElementById("pillSrc").textContent), null, { timeout: 8000 });
    await page.click("#btnPreview");
    await page.waitForFunction(() => /1920 x 1080/.test(document.getElementById("pvMeta").textContent), null, { timeout: 6000 });
    ok("export canvas matches the custom size", /1920 x 1080/.test(await page.locator("#pvMeta").textContent()));
    await page.click("#btnPvClose");

    /* the x removes a size and the canvas falls back off it */
    await page.locator("#presetBox .prow").last().locator(".pdel").click();
    await page.waitForTimeout(250);
    ok("x removes a size", (await page.locator("#presetBox .prow").count()) === baseRows + 1);
    ok("canvas falls back off the removed size", (await page.locator("#pillTarget").textContent()).indexOf("1280 x 741") < 0);
    await page.locator("#presetBox .prow").last().locator(".pdel").click();
    await page.waitForTimeout(250);
    ok("removals stick", (await page.locator("#presetBox .prow").count()) === baseRows);

    await page.click("#btnPzDefaults");
    await page.waitForTimeout(200);
    ok("defaults restore the shipped list", (await page.locator("#presetBox .prow").count()) === baseRows);

    ok("no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  /* ---------------- cropper inside a sandboxed preview frame ---------------- */
  console.log("\nimage-canvas-padder in a sandboxed frame (preview panels do this)");
  {
    const host = path.join(ROOT, "_host.html");
    fs.writeFileSync(host, '<!DOCTYPE html><html><body><iframe sandbox="allow-scripts allow-same-origin" ' +
      'src="/tools/image-canvas-padder/index.html" style="width:1200px;height:900px;border:0"></iframe></body></html>');
    const types = { ".html": "text/html", ".png": "image/png", ".jpg": "image/jpeg" };
    const srv = http.createServer((req, res) => {
      const f = path.join(ROOT, req.url.split("?")[0]);
      fs.readFile(f, (e, d) => {
        if (e) { res.writeHead(404); res.end("no"); return; }
        res.writeHead(200, { "Content-Type": types[path.extname(f)] || "application/octet-stream" });
        res.end(d);
      });
    });
    await new Promise(r => srv.listen(8731, r));

    const ctx = await browser.newContext({ viewport: { width: 1300, height: 1000 }, acceptDownloads: true });
    const page = await ctx.newPage();
    await page.goto("http://127.0.0.1:8731/_host.html");

    let fr = null;
    for (let i = 0; i < 60 && !fr; i++) {
      fr = page.frames().find(x => x.url().indexOf("image-canvas-padder") >= 0) || null;
      if (!fr) await page.waitForTimeout(100);
    }
    ok("cropper loaded inside the frame", !!fr);

    await fr.setInputFiles("#fileSrc", [FIXTURE]);
    await fr.waitForFunction(() => /920 x 1280/.test(document.getElementById("pillSrc").textContent), null, { timeout: 10000 });

    let got = null;
    page.once("download", d => { got = d; });
    await fr.click("#btnOne");
    await fr.waitForTimeout(1800);

    ok("sandbox really does block the download", got === null);
    ok("tool falls back to manual save", (await fr.textContent("#pvTitle")) === "SAVE YOUR FILE");
    ok("fallback says how to save", /Save image as/i.test(await fr.textContent("#pvNote")));
    ok("fallback hides the dead download button", await fr.locator("#btnPvDownload").isHidden());
    ok("fallback still offers a real image", (await fr.locator("#pvBody img").count()) === 1);

    await ctx.close();
    await new Promise(r => srv.close(r));
    fs.unlinkSync(host);
  }

  /* ---------------- editor ---------------- */
  console.log("\ncss-code-editor");
  {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1050 }, acceptDownloads: true });
    const page = await ctx.newPage();
    const errors = [];
    watch(page, errors);

    await page.goto(pathToFileURL(path.join(ROOT, "tools", "css-code-editor", "index.html")).href);
    await page.click("#btnSample");

    await page.waitForFunction(() => document.querySelectorAll("#panel .field").length > 3, null, { timeout: 8000 });
    const count = await page.locator("#panel .field").count();
    ok("items detected", count >= 4, count + " items");

    ok("iframe visible after render", await page.locator("#frame").isVisible());
    const hasText = await page.evaluate(() => {
      const d = document.getElementById("frame").contentDocument;
      return d.body.innerText.indexOf("slow mornings") >= 0;
    });
    ok("snippet rendered inside the iframe", hasText);

    /* the preview must hug the section: a short snippet used to leave a tall
       empty white sheet because the height measured itself in a loop.
       A device wider than the column is scaled to fit, so compare in the
       frame's own pixels. */
    const fit = await page.evaluate(() => {
      const f = document.getElementById("frame");
      const d = f.contentDocument;
      const s = window.__ppScale || 1;
      const w = document.getElementById("framewrap");
      return {
        frame: Math.round(f.getBoundingClientRect().height / s),
        content: Math.round(d.getElementById("__ppw").getBoundingClientRect().height),
        wrap: w.clientHeight,
        overflowY: w.scrollHeight - w.clientHeight,
        overflowX: w.scrollWidth - w.clientWidth,
        innerScroll: d.documentElement.scrollHeight - d.documentElement.clientHeight,
        innerWidth: d.documentElement.clientWidth,
        scale: s
      };
    });
    ok("preview height hugs the snippet", Math.abs(fit.frame - fit.content) <= 8, JSON.stringify(fit));
    ok("the box needs no scrollbar of its own", fit.overflowY <= 2, JSON.stringify(fit));
    ok("the box is not cut off sideways", fit.overflowX <= 2, JSON.stringify(fit));
    ok("the section itself never scrolls", fit.innerScroll <= 2, JSON.stringify(fit));
    ok("desktop preview keeps its real 1200 px width", fit.innerWidth === 1200, fit.innerWidth + " px");
    ok("a too-wide device is scaled down and says so",
      fit.scale < 1 && /shown at/.test(await page.locator("#vpNote").textContent()),
      fit.scale + " / " + await page.locator("#vpNote").textContent());

    /* The preview asks for no referrer on purpose. A host with hotlink
       protection answers 403 to an embedded image and 200 when the url is
       opened on its own - which makes the tool look broken. */
    const refMeta = await page.evaluate(() => {
      const d = document.getElementById("frame").contentDocument;
      const m = d.querySelector('meta[name="referrer"]');
      return m ? m.getAttribute("content") : null;
    });
    ok("preview asks for no referrer", refMeta === "no-referrer", String(refMeta));

    /* one editor open at a time */
    await page.locator("#panel .chip").first().click();
    ok("exactly one editor open", await page.locator("#panel .field.on .edit").count() === 1);

    /* click the h2 inside the iframe, then edit its text */
    const idx = await page.evaluate(() => {
      const d = document.getElementById("frame").contentDocument;
      const h = d.querySelector("h2");
      h.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return h.getAttribute("data-ppx");
    });
    ok("clicking an element marks it", idx !== null, "data-ppx=" + idx);
    const outlined = await page.evaluate(() => {
      const d = document.getElementById("frame").contentDocument;
      return !!d.querySelector(".__pp-on");
    });
    ok("selected element gets the outline", outlined);

    await page.fill('#panel .field.on input[data-f="text"]', "Made by hand in Bristol");
    await page.waitForTimeout(250);
    const liveText = await page.evaluate(() => document.getElementById("frame").contentDocument.querySelector("h2").textContent);
    ok("preview updates live", liveText.indexOf("Bristol") >= 0, liveText);
    const out1 = await page.evaluate(() => window.__ppOut);
    ok("code snippet syncs the new text", out1.indexOf("Bristol") >= 0);

    /* image URL swap */
    await page.evaluate(() => {
      const d = document.getElementById("frame").contentDocument;
      d.querySelector("img").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await page.fill('#panel .field.on input[data-f="url"]', "https://example.com/new-photo.jpg");
    await page.waitForTimeout(500);
    const out2 = await page.evaluate(() => window.__ppOut);
    ok("image URL written into the snippet", out2.indexOf("https://example.com/new-photo.jpg") >= 0);
    ok("the no-referrer rule stays inside the preview", out2.indexOf("referrer") < 0);

    /* an image the browser cannot fetch has to be explained. A grey box with
       alt text reads as a broken tool, and the most common cause is a host
       that refuses to serve its files to another domain. */
    await page.fill('#panel .field.on input[data-f="url"]', "https://blocked-host.invalid/photo.jpg");
    await page.waitForTimeout(4000);
    ok("a dead image gets a note, not a blank box", await page.locator("#imgNote").isVisible(),
      await page.locator("#imgNote").textContent());

    ok("no code display block on the page", await page.locator("#out").count() === 0);

    /* link + new tab: one row must carry text, url and the new-tab switch */
    await page.evaluate(() => {
      const d = document.getElementById("frame").contentDocument;
      d.querySelector("a").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const oneField = await page.evaluate(() => {
      const f = document.querySelector("#panel .field.on");
      return {
        label: f.querySelector(".kind").textContent,
        text: !!f.querySelector('input[data-f="text"]'),
        href: !!f.querySelector('input[data-f="href"]'),
        blank: !!f.querySelector('.cbx[data-f="blank"]')
      };
    });
    ok("button row carries text + link + new tab", oneField.text && oneField.href && oneField.blank, JSON.stringify(oneField));
    ok("button row is labelled", /BUTTON|LINK/.test(oneField.label), oneField.label);
    await page.fill('#panel .field.on input[data-f="href"]', "https://example.com/shop");
    await page.waitForTimeout(250);
    await page.click('#panel .field.on .cbx[data-f="blank"]');
    await page.waitForTimeout(250);
    const out3 = await page.evaluate(() => window.__ppOut);
    ok("href written", out3.indexOf('href="https://example.com/shop"') >= 0);
    ok("target blank written", out3.indexOf('target="_blank"') >= 0);

    /* a plain <button> has no href, and still has to take a link */
    await page.evaluate(() => {
      const d = document.getElementById("frame").contentDocument;
      d.querySelector("button").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const btnRow = await page.evaluate(() => {
      const f = document.querySelector("#panel .field.on");
      return {
        label: f.querySelector(".kind").textContent,
        text: !!f.querySelector('input[data-f="text"]'),
        href: !!f.querySelector('input[data-f="href"]'),
        blank: !!f.querySelector('.cbx[data-f="blank"]')
      };
    });
    ok("<button> row carries text + link + new tab", btnRow.text && btnRow.href && btnRow.blank, JSON.stringify(btnRow));
    ok("<button> row is labelled BUTTON", btnRow.label === "BUTTON", btnRow.label);

    const btnStyleBefore = await page.evaluate(() => document.getElementById("frame").contentDocument.querySelector("button").getAttribute("style"));
    await page.fill('#panel .field.on input[data-f="href"]', "https://example.com/a2f");
    await page.waitForTimeout(250);
    await page.click('#panel .field.on .cbx[data-f="blank"]');
    await page.waitForTimeout(250);
    const outBtn = await page.evaluate(() => window.__ppOut);
    ok("button link opens in a new tab", /<button[^>]*onclick="window\.open\('https:\/\/example\.com\/a2f', '_blank'/.test(outBtn),
      (outBtn.match(/<button[^>]*>/) || [])[0]);
    ok("no href smuggled onto the button", !/<button[^>]*\shref=/.test(outBtn));
    const btnStyleAfter = await page.evaluate(() => document.getElementById("frame").contentDocument.querySelector("button").getAttribute("style"));
    ok("button styling untouched while linking", btnStyleAfter === btnStyleBefore);

    /* switch the new tab off: same link, normal navigation */
    await page.click('#panel .field.on .cbx[data-f="blank"]');
    await page.waitForTimeout(250);
    const outBtn2 = await page.evaluate(() => window.__ppOut);
    ok("new tab switch off rewrites the handler", /onclick="location\.href='https:\/\/example\.com\/a2f'"/.test(outBtn2),
      (outBtn2.match(/<button[^>]*>/) || [])[0]);

    /* style panel writes inline css only */
    await page.click("#btnTgtSection");
    await page.evaluate(() => {
      const el = document.getElementById("bgCol");
      el.value = "#0A0A0A";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(250);
    const out4 = await page.evaluate(() => window.__ppOut);
    ok("background colour injected inline", /background(-color)?:\s*(#0A0A0A|rgb\(10, 10, 10\))/i.test(out4),
      (out4.match(/background-color:[^;"]*/) || [])[0]);

    /* marker leakage - the thing that silently ruins an export */
    ok("no data-ppx in the export", out4.indexOf("data-ppx") < 0);
    ok("no __pp classes in the export", out4.indexOf("__pp") < 0);
    ok("no empty class attributes in the export", out4.indexOf('class=""') < 0);

    /* structure preserved: same tag inventory as the input */
    const srcTags = await page.evaluate(() => (document.getElementById("src").value.match(/<[a-z][a-z0-9]*/gi) || []).length);
    const outTags = await page.evaluate(() => (window.__ppOut.match(/<[a-z][a-z0-9]*/gi) || []).length);
    ok("element count unchanged by editing", srcTags === outTags, srcTags + " -> " + outTags);

    /* reset styles clears what we added */
    await page.click("#btnResetStyle");
    await page.waitForTimeout(200);
    const out5 = await page.evaluate(() => window.__ppOut);
    ok("style reset removes the inline colour", !/background-color:\s*#0A0A0A/i.test(out5));

    /* ---------------- transparency + frosted glass ---------------- */
    await page.evaluate(() => {
      const el = document.getElementById("bgOp");
      el.value = "40";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(250);
    const outOp = await page.evaluate(() => window.__ppOut);
    ok("opacity turns the colour into rgba",
      /background-color:\s*rgba\(\d+,\s*\d+,\s*\d+,\s*0\.4\)/.test(outOp),
      (outOp.match(/background-color:[^;"]*/) || [])[0]);

    await page.click('[data-glass="light"]');
    await page.waitForTimeout(300);
    const outGlass = await page.evaluate(() => window.__ppOut);
    ok("glass preset writes backdrop-filter", /backdrop-filter:\s*blur\(14px\)/.test(outGlass));
    ok("glass preset writes the webkit fallback", /-webkit-backdrop-filter/.test(outGlass));
    ok("glass preset is see-through", /background-color:\s*rgba\(255,\s*255,\s*255,\s*0\.55\)/.test(outGlass));
    ok("glass preset adds a hairline border", /border:\s*1px solid/.test(outGlass));

    await page.evaluate(() => {
      const el = document.getElementById("blur");
      el.value = "20";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(250);
    ok("blur slider drives the filter", /blur\(20px\)/.test(await page.evaluate(() => window.__ppOut)));

    await page.click('[data-glass="clear"]');
    await page.waitForTimeout(250);
    const outClear = await page.evaluate(() => window.__ppOut);
    ok("CLEAR takes the glass back off",
      !/backdrop-filter/.test(outClear) && !/-webkit-backdrop-filter/.test(outClear));

    /* ---------------- css tidying ---------------- */
    const tidyRes = await page.evaluate(() => window.tidyStyleAttr("color:red;;padding: 0px 4px;;color:#FFFFFF"));
    ok("tidy drops empty declarations", !/;;/.test(tidyRes), tidyRes);
    ok("tidy normalises the colon", /^color: /.test(tidyRes), tidyRes);
    ok("tidy collapses 0px", /padding: 0 4px/.test(tidyRes), tidyRes);
    ok("tidy keeps the last of two duplicates and shortens the hex",
      /#FFF/i.test(tidyRes) && !/red/.test(tidyRes), tidyRes);

    const tidyUrl = await page.evaluate(() =>
      window.tidyCssText("a{background:url(https://x.com/a.png) no-repeat;color:#111111}"));
    ok("tidy leaves urls untouched", tidyUrl.indexOf("https://x.com/a.png") >= 0, tidyUrl);
    ok("tidy still tidies real declarations", /color: #111111/.test(tidyUrl), tidyUrl);

    /* ---------------- compact output ---------------- */
    const readableOut = await page.evaluate(() => window.__ppOut);
    await page.click("#btnMinify");
    await page.waitForTimeout(300);
    const compactOut = await page.evaluate(() => window.__ppOut);
    const tagCount = s => (s.match(/<[a-z][a-z0-9]*/gi) || []).length;
    ok("compact output has no line breaks", compactOut.indexOf("\n") < 0);
    ok("compact output is shorter", compactOut.length < readableOut.length, readableOut.length + " -> " + compactOut.length);
    ok("compact output keeps every tag", tagCount(compactOut) === tagCount(readableOut),
      tagCount(readableOut) + " -> " + tagCount(compactOut));
    ok("minify button states the mode", /ONE LINE/.test(await page.locator("#btnMinify").textContent()));
    await page.click("#btnMinify");
    await page.waitForTimeout(250);
    ok("and it switches back", /INDENTED/.test(await page.locator("#btnMinify").textContent()));

    /* export html */
    {
      const dl = page.waitForEvent("download", { timeout: 15000 });
      await page.click("#btnExport");
      const d = await dl;
      const name = d.suggestedFilename();
      ok("export is an html file", /^section-snippet-\d{4}-\d{2}-\d{2}\.html$/.test(name), name);
      const out = path.join(ROOT, "output", name);
      await d.saveAs(out);
      const body = fs.readFileSync(out, "utf8");
      ok("exported file holds the section", body.indexOf("<section") >= 0 && body.indexOf("Bristol") >= 0);
    }

    /* viewport switch */
    await page.click('[data-vp="390"]');
    ok("mobile viewport applied", await page.evaluate(() => document.getElementById("frame").style.width) === "390px");
    ok("a device that fits is shown at full size",
      await page.evaluate(() => window.__ppScale) === 1,
      await page.locator("#vpNote").textContent());

    /* copy must hand the snippet out without showing it */
    await page.click("#btnCopy");
    await page.waitForTimeout(200);
    const copyStatus = await page.textContent("#status");
    ok("copy reports a result", /COPIED|CLIPBOARD/.test(copyStatus), copyStatus);

    ok("no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  /* ---------------- editor: plain css, the Squarespace default ---------------- */
  console.log("\ncss-code-editor (plain css)");
  {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1050 }, acceptDownloads: true });
    const page = await ctx.newPage();
    const errors = [];
    watch(page, errors);

    await page.goto(pathToFileURL(path.join(ROOT, "tools", "css-code-editor", "index.html")).href);
    await page.click("#btnSampleCss");
    await page.waitForFunction(() => document.querySelectorAll("#panel .rule").length > 3, null, { timeout: 8000 });

    const rules = await page.locator("#panel .rule").count();
    ok("every css rule is listed", rules === 6, rules + " rules");
    ok("detection reports css", /CSS/.test(await page.textContent("#detNote")), await page.textContent("#detNote"));
    ok("scaffold note is shown", await page.locator("#scafNote").isVisible());
    ok("quick css box steps aside in css mode", await page.locator("#quickBox").isHidden());
    ok("panel is the rule list", /CSS RULES/.test(await page.textContent("#panelTitle")));

    /* the class names have to become something you can look at */
    const scaf = await page.evaluate(() => {
      const d = document.getElementById("frame").contentDocument;
      const t = d.querySelector(".card-title");
      const it = d.querySelector(".card-item");
      if (!t) return null;
      const cs = d.defaultView.getComputedStyle(t);
      return {
        title: t.textContent.trim(),
        size: cs.fontSize,
        weight: cs.fontWeight,
        item: it ? d.defaultView.getComputedStyle(it).display : "",
        items: d.querySelectorAll(".card-item").length
      };
    });
    ok("scaffold renders the class names", !!scaf && scaf.title.length > 0, JSON.stringify(scaf));
    ok("scaffold picks up the real values", !!scaf && scaf.size === "24px" && scaf.weight === "600", JSON.stringify(scaf));
    ok("flex layout reaches the scaffold", !!scaf && scaf.item === "flex", JSON.stringify(scaf));
    ok("list rule makes more than one item", !!scaf && scaf.items >= 2, JSON.stringify(scaf));

    /* the box must not grow its own scrollbar in either direction */
    const boxFit = await page.evaluate(() => {
      const w = document.getElementById("framewrap");
      const d = document.getElementById("frame").contentDocument;
      return {
        y: w.scrollHeight - w.clientHeight,
        x: w.scrollWidth - w.clientWidth,
        inner: d.documentElement.scrollHeight - d.documentElement.clientHeight
      };
    });
    ok("css mode preview does not scroll", boxFit.y <= 2 && boxFit.x <= 2 && boxFit.inner <= 2, JSON.stringify(boxFit));

    /* open one rule and change a value: css mode, not html mode */
    await page.locator('#panel .rule:has-text(".card-title") .rule-h').click();
    await page.waitForSelector("#panel .rule.on .dl", { timeout: 4000 });
    ok("one rule opens at a time", await page.locator("#panel .rule.on").count() === 1);

    await page.locator('#panel .rule.on .dl', { hasText: "font-size" }).locator("input.dl-i").fill("32px");
    await page.waitForTimeout(300);
    const outCss1 = await page.evaluate(() => window.__ppOut);
    ok("edited value lands in the css", /font-size:\s*32px/.test(outCss1), (outCss1.match(/font-size:[^;]*/) || [])[0]);
    const liveSize = await page.evaluate(() => {
      const d = document.getElementById("frame").contentDocument;
      return d.defaultView.getComputedStyle(d.querySelector(".card-title")).fontSize;
    });
    ok("preview follows the edit", liveSize === "32px", liveSize);

    /* !important is a switch, not something you type */
    await page.locator("#panel .rule.on .dl", { hasText: "font-size" }).locator(".bang").click();
    await page.waitForTimeout(300);
    const outCss2 = await page.evaluate(() => window.__ppOut);
    ok("!important toggles on", /font-size:\s*32px\s*!important/.test(outCss2), (outCss2.match(/font-size:[^;]*/) || [])[0]);
    await page.locator("#panel .rule.on .dl", { hasText: "font-size" }).locator(".bang").click();
    await page.waitForTimeout(300);
    ok("!important toggles back off", !/!important/.test(await page.evaluate(() => window.__ppOut)));

    /* what you copy is your css, never the scaffold */
    ok("no html in the css output", !/[<>]/.test(outCss1), outCss1.slice(0, 80));
    ok("no scaffold markers in the css output", outCss1.indexOf("__pp") < 0 && outCss1.indexOf("data-ppx") < 0);
    ok("the comment is left alone", outCss1.indexOf("Custom CSS") >= 0);

    /* export a real .css file */
    ok("export button knows this is css", /EXPORT \.CSS/.test(await page.textContent("#btnExport")),
      await page.textContent("#btnExport"));
    {
      const dl = page.waitForEvent("download", { timeout: 15000 });
      await page.click("#btnExport");
      const d = await dl;
      const name = d.suggestedFilename();
      ok("export is a css file", /^custom-css-\d{4}-\d{2}-\d{2}\.css$/.test(name), name);
      const out = path.join(ROOT, "output", name);
      await d.saveAs(out);
      const body = fs.readFileSync(out, "utf8");
      ok("exported css holds the rules", body.indexOf(".card-title") >= 0);
      ok("exported css carries the edit", /font-size:\s*32px/.test(body));
      ok("exported css is not html", body.indexOf("<div") < 0 && body.indexOf("<style") < 0);
    }

    /* one line mode, then copy */
    const before = await page.evaluate(() => window.__ppOut);
    await page.click("#btnMinify");
    await page.waitForTimeout(300);
    const flat = await page.evaluate(() => window.__ppOut);
    ok("one line has no line breaks", flat.indexOf("\n") < 0);
    ok("one line is shorter", flat.length < before.length, before.length + " -> " + flat.length);
    ok("one line keeps every rule", (flat.match(/\}/g) || []).length === (before.match(/\}/g) || []).length);
    await page.click("#btnMinify");
    await page.waitForTimeout(250);

    await page.click("#btnCopy");
    await page.waitForTimeout(250);
    ok("copy reports a result", /COPIED|CLIPBOARD/.test(await page.textContent("#status")), await page.textContent("#status"));

    /* forcing HTML on css, and css on html, must not lie about what happened */
    await page.click('[data-mode="html"]');
    await page.waitForTimeout(400);
    ok("forcing html on css is allowed to fail loudly",
      /forced: HTML/.test(await page.textContent("#detNote")), await page.textContent("#detNote"));
    await page.click('[data-mode="auto"]');
    await page.waitForTimeout(400);

    ok("no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  await browser.close();
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("SUITE ERROR", e); process.exit(1); });
