// Firefox end-to-end test (Selenium + geckodriver, temporary add-on install).
// Needs the r-aloud server running.
import { Builder } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { fileURLToPath } from "node:url";
import { localPdfUrl, runLongScenario, runPauseScenario, runPdfScenario, runScenario, servePage } from "./scenario.mjs";

import { readFileSync } from "node:fs";
const { version } = JSON.parse(readFileSync(new URL("../../manifest.base.json", import.meta.url), "utf8"));
const xpi = fileURLToPath(new URL(`../../dist/r-aloud-firefox-${version}.xpi`, import.meta.url));
const ADDON_ID = "r-aloud@akanksh.dev";
const UUID = "6f1c2b9e-0d5a-4c1e-9b7a-2f3e4d5c6b7a";

const page = await servePage();
const LONG = process.argv.includes("--long");
const articleUrl = LONG ? page.url + "long" : page.url;
const options = new firefox.Options()
  .addArguments("-headless")
  // Fixed internal UUID so we can open the popup page by URL.
  .setPreference("extensions.webextensions.uuids", JSON.stringify({ [ADDON_ID]: UUID }))
  .setPreference("media.volume_scale", "0.0")
  .setPreference("media.autoplay.default", 0);
if (process.env.FIREFOX_BIN) options.setBinary(process.env.FIREFOX_BIN);

// System access lets the test open the popup page from browser chrome.
const service = new firefox.ServiceBuilder().addArguments("--allow-system-access");
const driver = await new Builder()
  .forBrowser("firefox").setFirefoxOptions(options).setFirefoxService(service).build();
try {
  await driver.installAddon(xpi, true);
  await driver.get(articleUrl);
  const articleHandle = await driver.getWindowHandle();
  // Content can't navigate to moz-extension:// pages; open it from browser chrome.
  await driver.setContext(firefox.Context.CHROME);
  await driver.executeScript(
    `gBrowser.selectedTab = gBrowser.addTab(arguments[0], {
       triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`,
    `moz-extension://${UUID}/popup/popup.html`,
  );
  await driver.setContext(firefox.Context.CONTENT);
  let popupHandle;
  for (let i = 0; i < 50 && !popupHandle; i++) {
    for (const h of await driver.getAllWindowHandles()) {
      if (h === articleHandle) continue;
      await driver.switchTo().window(h);
      if ((await driver.getCurrentUrl()).includes("/popup/popup.html")) popupHandle = h;
    }
    if (!popupHandle) await new Promise((r) => setTimeout(r, 200));
  }
  if (!popupHandle) throw new Error("popup tab did not open");

  const runIn = (handle) => async (src, arg) => {
    await driver.switchTo().window(handle);
    const out = await driver.executeAsyncScript(
      `const done = arguments[arguments.length - 1];
       Promise.resolve((${src})(arguments[0]))
         .then((v) => done({ v: v === undefined ? null : v }), (e) => done({ e: String(e) }));`,
      arg ?? null,
    );
    if (out.e) throw new Error(out.e);
    return out.v;
  };
  const ctx = { inPopup: runIn(popupHandle), inPage: runIn(articleHandle), pageUrl: articleUrl };
  const closePopup = async () => {
    await driver.switchTo().window(popupHandle);
    await driver.close();
    await driver.switchTo().window(articleHandle);
  };
  const navigate = async (url) => {
    await driver.switchTo().window(articleHandle);
    await driver.get(url);
  };
  if (process.argv.includes("--pdf")) {
    await runPdfScenario({ ...ctx, navigate, fileUrl: localPdfUrl(), httpUrl: page.url + "doc.pdf" });
  } else if (LONG) await runLongScenario({ ...ctx, closePopup });
  else if (process.argv.includes("--pause")) await runPauseScenario(ctx);
  else await runScenario(ctx);
  console.log("FIREFOX E2E PASSED");
} finally {
  await driver.quit();
  page.close();
}
