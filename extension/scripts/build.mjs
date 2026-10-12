// Build browser-specific extension folders (and zips) from src/.
// Usage: node scripts/build.mjs [chrome|firefox ...] [--zip]
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = JSON.parse(readFileSync(join(root, "manifest.base.json"), "utf8"));

const targets = {
  chrome: (m) => ({
    ...m,
    minimum_chrome_version: "116",
    permissions: [...m.permissions, "offscreen"],
    background: { service_worker: "background.js", type: "module" },
  }),
  firefox: (m) => ({
    ...m,
    background: { scripts: ["background.js"], type: "module" },
    browser_specific_settings: {
      gecko: {
        id: "r-aloud@akanksh.dev",
        strict_min_version: "140.0",
        data_collection_permissions: { required: ["none"] },
      },
    },
  }),
};

const args = process.argv.slice(2);
const zip = args.includes("--zip");
const wanted = args.filter((a) => !a.startsWith("--"));
for (const name of wanted.length ? wanted : Object.keys(targets)) {
  const out = join(root, "dist", name);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(root, "src"), out, {
    recursive: true,
    // Firefox has no offscreen API; the background page plays audio itself.
    filter: (p) => !(name === "firefox" && p.includes(`${join("src", "offscreen")}`)) && !p.endsWith(".svg"),
  });
  // pdf.js for the PDF reader (unminified so store reviewers can match it upstream).
  const pdfjs = join(root, "node_modules", "pdfjs-dist");
  const vendor = join(out, "vendor", "pdfjs");
  for (const f of ["build/pdf.mjs", "build/pdf.worker.mjs", "LICENSE"]) {
    cpSync(join(pdfjs, f), join(vendor, f.split("/").pop()));
  }
  for (const d of ["cmaps", "standard_fonts", "wasm", "iccs"]) cpSync(join(pdfjs, d), join(vendor, d), { recursive: true });
  writeFileSync(join(out, "manifest.json"), JSON.stringify(targets[name](base), null, 2) + "\n");
  console.log(`built dist/${name}`);
  if (zip) {
    const file = join(root, "dist", `r-aloud-${name}-${base.version}.${name === "firefox" ? "xpi" : "zip"}`);
    rmSync(file, { force: true });
    execFileSync("zip", ["-qr", "-X", file, "."], { cwd: out });
    console.log(`packed ${file}`);
  }
}
