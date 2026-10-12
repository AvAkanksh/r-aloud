// Chrome/Chromium end-to-end test (Playwright). Needs the r-aloud server running.
import { chromium } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { localPdfUrl, runLongScenario, runPauseScenario, runPdfScenario, runScenario, servePage } from "./scenario.mjs";

const extDir = fileURLToPath(new URL("../../dist/chrome", import.meta.url));
const profile = mkdtempSync(join(tmpdir(), "r-aloud-chrome-"));
const page = await servePage();
const LONG = process.argv.includes("--long");
const PDF = process.argv.includes("--pdf");
const articleUrl = LONG ? page.url + "long" : page.url;

const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  // HEADED=1 runs a real window with audible output (use with a silent
  // PULSE_SINK and xvfb-run). Headless Chrome never counts audio as audible,
  // so it closes the offscreen player after 30 s and exercises recovery instead.
  headless: !process.env.HEADED,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
    ...(process.env.HEADED ? [] : ["--mute-audio"])],
});
try {
  let sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  const extId = new URL(sw.url()).host;
  if (PDF) {
    // Local PDFs need "Allow access to file URLs" (on by default for unpacked
    // extensions; flipping it reloads the extension).
    const settings = await ctx.newPage();
    await settings.goto(`chrome://extensions/?id=${extId}`);
    const toggle = settings.locator("#allow-on-file-urls");
    if (!(await toggle.evaluate((e) => e.checked))) {
      const reloaded = ctx.waitForEvent("serviceworker");
      await toggle.click();
      sw = await reloaded;
    }
    await settings.close();
  }
  const article = await ctx.newPage();
  const errors = [];
  article.on("pageerror", (e) => errors.push(e.message));
  await article.goto(articleUrl);
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);

  const run = (p) => (src, arg) => p.evaluate(`(${src})(${JSON.stringify(arg ?? null)})`);
  const driver = { inPopup: run(popup), inPage: run(article), pageUrl: articleUrl };
  const navigate = (url) => article.goto(url).catch(() => {}); // PDFs may not fire "load"
  if (PDF) await runPdfScenario({ ...driver, navigate, fileUrl: localPdfUrl(), httpUrl: page.url + "doc.pdf" });
  else if (LONG) await runLongScenario({ ...driver, closePopup: () => popup.close() });
  else if (process.argv.includes("--pause")) await runPauseScenario(driver);
  else await runScenario(driver);
  if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
  console.log("CHROME E2E PASSED");
} finally {
  await ctx.close();
  page.close();
  rmSync(profile, { recursive: true, force: true });
}
