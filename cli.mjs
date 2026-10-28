// Command-line mode. Same engine as the local UI.
//
//   node cli.mjs links.txt --out "E:\Downloads"
//   node cli.mjs links.txt --check
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, runBatch, parseLinks, human, closeBrowser, ensureAria2 } from "./bot.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARIA2C = path.join(HERE, "tools", "aria2c.exe");

const opts = { out: "downloads", profile: ".profile", verifyTimeout: 900, parallel: 3, check: false, inputs: [] };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--out") opts.out = argv[++i];
  else if (a === "--profile") opts.profile = argv[++i];
  else if (a === "--port") opts.port = Number(argv[++i]);
  else if (a === "--parallel") opts.parallel = Math.max(1, Number(argv[++i]) || 3);
  else if (a === "--verify-timeout") opts.verifyTimeout = Number(argv[++i]);
  else if (a === "--check") opts.check = true;
  else if (a === "-h" || a === "--help") opts.help = true;
  else opts.inputs.push(a);
}

if (opts.help || opts.inputs.length === 0) {
  console.log(`Ndownloader2

  node cli.mjs <links.txt | url ...> [--out DIR] [--parallel N] [--check]

  --out        where files land (default: ./downloads)
  --parallel   how many files download at once (default: 3)
  --check      only report ONLINE/OFFLINE + size, download nothing

One link per line. A trailing #filename becomes the file name:
  https://host/abc#Game.part01.rar

Prefer a window with a paste box and a folder picker? Double-click run.bat`);
  process.exit(opts.help ? 0 : 1);
}

await ensureAria2();

const raw = [];
for (const input of opts.inputs) {
  if (fs.existsSync(input)) raw.push(fs.readFileSync(input, "utf8"));
  else raw.push(input);
}
const links = parseLinks(raw.join("\n"));
const outDir = path.resolve(opts.out);

console.log(`\nNdownloader2 — ${links.length} link(s) -> ${outDir}  (parallel: ${opts.parallel})\n`);

const { ctx, page, browser } = await launchBrowser({ profileDir: opts.profile, port: opts.port || 9333 });

const emit = (e) => {
  if (e.t === "link") console.log(`[${e.i + 1}/${links.length}] resolving ${e.link.slice(0, 80)}`);
  else if (e.t === "challenge") {
    console.log(e.on
      ? "\n  >>> Cloudflare wants a human check. Click \"Verify you are human\" in the Edge window.\n"
      : "\n  >>> Cleared, continuing.\n");
  } else if (e.t === "status") {
    if (e.status === "downloading") console.log(`[${e.i + 1}/${links.length}]  start  ${e.file}${e.sizeText ? ` (${e.sizeText})` : ""}`);
    else if (e.status !== "resolving") console.log(`[${e.i + 1}/${links.length}]  x ${e.status}${e.note ? " — " + e.note : ""}`);
  } else if (e.t === "done") {
    console.log(`[${e.i + 1}/${links.length}]  ${e.ok ? "done" : "FAILED"}  ${human(e.bytes)}  ${e.file}`);
  } else if (e.t === "summary") {
    console.log("\n===== SUMMARY =====");
    for (const r of e.results) console.log(` ${r.status.padEnd(20)} ${(r.size || "").padEnd(9)} ${(r.file || r.link).toString().slice(-70)}`);
    console.log("\n" + Object.entries(e.counts).map(([k, v]) => `${k}: ${v}`).join("  |  "));
  }
};

try {
  await runBatch({ ctx, uiPage: page, links, outDir, parallel: opts.parallel, verifyTimeout: opts.verifyTimeout, check: opts.check, emit, aria2cPath: ARIA2C });
} finally {
  await closeBrowser(browser);
}


