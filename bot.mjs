// Core engine shared by the CLI and the local UI.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAGING = path.join(HERE, ".staging");
const LOGDIR = path.join(HERE, "logs");
const ARIA2C = path.join(HERE, "tools", "aria2c.exe");

// aria2c is not committed to the repo; fetch it once on first run.
export async function ensureAria2() {
  if (fs.existsSync(ARIA2C)) return true;
  const tools = path.dirname(ARIA2C);
  fs.mkdirSync(tools, { recursive: true });
  const url = "https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip";
  console.log("First run: downloading aria2c...");
  const r = await fetch(url).catch(() => null);
  if (!r || !r.ok) throw new Error("could not download aria2c - check your internet connection");
  const zip = path.join(tools, "aria2.zip");
  fs.writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
  await new Promise((resolve, reject) => {
    const q = (p) => p.replace(/'/g, "''");
    const ps = spawn("powershell", ["-NoProfile", "-Command",
      `Expand-Archive -LiteralPath '${q(zip)}' -DestinationPath '${q(tools)}' -Force`],
      { stdio: "ignore" });
    ps.on("error", reject);
    ps.on("exit", (c) => (c === 0 ? resolve() : reject(new Error("could not unzip aria2c"))));
  });
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.toLowerCase() === "aria2c.exe") found.push(full);
    }
  };
  walk(tools);
  if (!found.length) throw new Error("aria2c.exe missing after unzip");
  fs.copyFileSync(found[0], ARIA2C);
  fs.rmSync(zip, { force: true });
  for (const f of found) { if (path.resolve(f) !== path.resolve(ARIA2C)) fs.rmSync(path.dirname(f), { recursive: true, force: true }); }
  console.log("aria2c ready.");
  return true;
}

const BTN_SEL = "a:has-text('DOWNLOAD'), button:has-text('DOWNLOAD'), a:has-text('Download'), button:has-text('Download')";
const CHALLENGE = /just a moment|checking your browser|attention required|ddos-guard|performing security verification/i;

// Hosts the "first click" tries to open instead of the file.
const ADS = [
  "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adservice.google.com",
  "popads.net", "popcash.net", "propellerads.com", "propellerclick.com", "onclckds.com",
  "adsterra.com", "exoclick.com", "exosrv.com", "juicyads.com", "clickadu.com", "hilltopads.net",
  "trafficjunky.net", "realsrv.com", "adsco.re", "mgid.com", "taboola.com", "outbrain.com",
  "revcontent.com", "zergnet.com", "adnxs.com", "criteo.com", "rubiconproject.com",
  "pubmatic.com", "openx.net", "casalemedia.com", "33across.com", "sharethrough.com",
  "scorecardresearch.com", "quantserve.com", "h4mdc5m.space",
];

// host/abc#Name.part01.rar  ->  name comes from the fragment
export function parseLinks(text) {
  const seen = new Set();
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const link = line.trim();
    if (!link || link.startsWith("#") || link.startsWith("//")) continue;
    if (seen.has(link)) continue;
    seen.add(link);
    out.push({ link, name: nameFromLink(link) });
  }
  return out;
}

export function nameFromLink(link) {
  try {
    const u = new URL(link);
    if (u.hash.length > 1) return decodeURIComponent(u.hash.slice(1));
  } catch { /* not a url */ }
  return null;
}

// "2.0GB" -> bytes
export function parseSize(text) {
  const m = String(text).match(/([\d.]+)\s*([KMGT])B/i);
  if (!m) return null;
  const units = { K: 1, M: 2, G: 3, T: 4 };
  const u = units[m[2].toUpperCase()];
  if (!u) return null;
  return Math.round(parseFloat(m[1]) * 1024 ** u);
}

export const human = (b) => {
  if (!b || b < 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(1)} ${u[i]}`;
};

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

// Playwright's own launcher starts a browser whose window never surfaces on this
// machine (no MainWindowHandle), which makes a human Cloudflare check impossible.
// Launching Edge as a normal detached process gives a real window; we then attach.
async function waitForCdp(port, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

export async function launchBrowser({ profileDir, startUrl, port = 9333 }) {
  const exe = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!exe) throw new Error("Microsoft Edge not found");
  fs.mkdirSync(profileDir, { recursive: true });

  let version = await waitForCdp(port, 1500);
  if (!version) {
    const child = spawn(exe, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${path.resolve(profileDir)}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1450,920",
      "--window-position=50,40",
      startUrl || "about:blank",
    ], { detached: true, stdio: "ignore" });
    child.unref();
    version = await waitForCdp(port);
  }
  if (!version) throw new Error("Edge did not expose a debugging port — close all Edge windows and try again.");

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  browser.on("disconnected", () => console.log("  (browser window was closed)"));

  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  await ctx.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => undefined }));
  await ctx.route("**/*", (route) => {
    let host = "";
    try { host = new URL(route.request().url()).hostname; } catch { return route.continue().catch(() => {}); }
    if (ADS.some((d) => host === d || host.endsWith("." + d))) return route.abort().catch(() => {});
    return route.continue().catch(() => {});
  });

  const pages = ctx.pages();
  const page = (startUrl && pages.find((p) => p.url().startsWith(startUrl))) || pages[0] || (await ctx.newPage());
  if (startUrl && !page.url().startsWith(startUrl)) await page.goto(startUrl).catch(() => {});
  await ensureVisible(page);
  return { ctx, page, browser };
}

export async function ensureVisible(page) {
  try {
    await page.bringToFront();
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "maximized" } });
  } catch { /* not fatal */ }
}

export async function closeBrowser(browser) {
  try {
    const ctx = browser.contexts()[0];
    const page = ctx?.pages()[0];
    if (page) {
      const s = await ctx.newCDPSession(page);
      await s.send("Browser.close").catch(() => {});
    }
  } catch { /* fall through */ }
  try { await browser.close(); } catch { /* already gone */ }
}

const isChallenge = async (page) => {
  const title = await page.title().catch(() => "");
  if (CHALLENGE.test(title)) return true;
  const body = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  return CHALLENGE.test(body.slice(0, 600));
};

async function waitForReady(page, verifyTimeoutSec, downloaded, emit) {
  const deadline = Date.now() + verifyTimeoutSec * 1000;
  let told = false;
  while (Date.now() < deadline) {
    if (downloaded()) return "ready";
    if (await isChallenge(page)) {
      if (!told) { emit({ t: "challenge", on: true }); told = true; }
      await page.bringToFront().catch(() => {});
      await page.waitForTimeout(1500);
      continue;
    }
    if (told) { emit({ t: "challenge", on: false }); told = false; }
    if (await page.locator(BTN_SEL).count().catch(() => 0)) return "ready";
    await page.waitForTimeout(1500);
  }
  return told ? "verify-timeout" : "no-download-button";
}

// Handles: direct file link, redirect chain, and "first click opens an ad" pages.
async function resolveOne({ ctx, workPage, uiPage, link, verifyTimeout, emit }) {
  const found = [];
  const handlers = [];
  const hook = (p) => {
    const h = async (d) => {
      found.push({ fileUrl: d.url(), referer: p.url(), suggested: d.suggestedFilename() });
      try { await d.cancel(); } catch {}
    };
    handlers.push([p, h]);
    p.on("download", h);
  };
  const onPage = (p) => hook(p);
  hook(workPage);
  ctx.on("page", onPage);
  const unhook = () => {
    ctx.off("page", onPage);
    for (const [p, h] of handlers) { try { p.off("download", h); } catch {} }
  };

  let state = "ready";
  try {
    await workPage.goto(link, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    if (found.length === 0) state = await waitForReady(workPage, verifyTimeout, () => found.length > 0, emit);
  } catch { /* keep going */ }

  // Guard: if the tab is still showing a DIFFERENT link, clicking would capture the
  // wrong file (this is how two parts ended up as identical downloads). Verify first.
  const pathOf = (u) => { try { const x = new URL(u); return { host: x.hostname, path: x.pathname }; } catch { return null; } };
  if (found.length === 0 && state === "ready") {
    const want = pathOf(link);
    const cur = pathOf(workPage.url());
    const wrong = want && cur && (cur.host !== want.host || (want.path.length > 1 && !cur.path.startsWith(want.path)));
    if (wrong) {
      await workPage.goto(link, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      state = await waitForReady(workPage, verifyTimeout, () => found.length > 0, emit);
      const cur2 = pathOf(workPage.url());
      if (found.length === 0 && cur2 && (cur2.host !== want.host || (want.path.length > 1 && !cur2.path.startsWith(want.path)))) {
        return { state: "wrong-page", fileUrl: null, size: null, sizeText: null, note: `page never loaded, still showing ${cur2.host}` };
      }
    }
  }

  const body = await workPage.evaluate(() => document.body?.innerText || "").catch(() => "");
  const sizeText = body.match(/Size:\s*([\d.]+\s*[KMGT]B)/i)?.[1] || null;
  const size = sizeText ? parseSize(sizeText) : null;

  if (state !== "ready") {
    unhook();
    return { state, fileUrl: null, size, sizeText, note: body.slice(0, 140).replace(/\s+/g, " ") };
  }

  try {
    for (let round = 1; round <= 6 && found.length === 0; round++) {
      const btn = workPage.locator(BTN_SEL).first();
      if (!(await btn.count().catch(() => 0))) break;
      await btn.click({ timeout: 15000 }).catch(() => {});
      await workPage.waitForTimeout(3000);
      for (const p of ctx.pages()) {
        if (p === workPage || p === uiPage) continue;
        await p.close().catch(() => {});
      }
      await workPage.waitForTimeout(1200);
    }
    if (found.length === 0) await workPage.waitForTimeout(8000);
  } finally {
    unhook();
  }

  const hit = found[0];
  return { state: hit ? "resolved" : "no-download-started", fileUrl: hit?.fileUrl || null, referer: hit?.referer, suggested: hit?.suggested, size, sizeText };
}

// ---------------------------------------------------------------- downloading

// aria2c can be refused write access to perfectly normal folders (antivirus, or a
// restricted token). Node usually can write there, so on refusal we stage the file
// next to the app and let Node move it into place once it is finished.
function spawnAria2c({ dir, filename, fileUrl, headers, limitKbps }, logPath) {
  const args = [
    // Some hosts ignore Range requests and always stream offset..EOF, which makes
    // aria2c abort extra connections ("Invalid range header"). One is immune.
    "-x1", "-s1",
    "--continue=true", "--auto-file-renaming=false", "--allow-overwrite=false",
    "--max-tries=3", "--retry-wait=5", "--timeout=60", "--console-log-level=warn",
    "--summary-interval=0", "--file-allocation=none", "--auto-save-interval=1",
    // Write straight through: aria2c's 16 MB write cache otherwise makes the file
    // (and therefore progress and slow-mode) look frozen.
    "--disk-cache=0",
    "-d", dir, "-o", filename,
  ];
  if (limitKbps > 0) args.push(`--max-download-limit=${limitKbps}K`);
  for (const [k, v] of Object.entries(headers)) if (v) args.push(`--header=${k}: ${v}`);
  args.push(fileUrl);

  const fd = fs.openSync(logPath, "w");
  const child = spawn(ARIA2C, args, { stdio: ["ignore", fd, fd] });
  child.on("close", () => { try { fs.closeSync(fd); } catch {} });
  return child;
}

function readReason(logPath) {
  try {
    const lines = fs.readFileSync(logPath, "utf8")
      .split(/\r?\n/)
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim())
      .filter((l) => /ERROR|Exception|denied/.test(l));
    if (!lines.length) return null;
    const denied = lines.find((l) => /Access is denied/i.test(l));
    if (denied) return "aria2c was refused write access to that folder";
    return lines[lines.length - 1].slice(0, 200);
  } catch { return null; }
}

const moveFile = (from, to) => {
  try { fs.renameSync(from, to); return true; }
  catch (e) {
    if (e.code !== "EXDEV" && e.code !== "EPERM") throw e;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
    return true;
  }
};

// Lightweight availability check: open the page, read its size and whether it
// says the file is gone. No clicking, so it is quick and leaves no ad tabs.
export async function probeOne({ ctx, workPage, link, verifyTimeout = 120, emit }) {
  let state = "ready";
  try {
    await workPage.goto(link, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    state = await waitForReady(workPage, verifyTimeout, () => false, emit || (() => {}));
  } catch { /* treat as unreachable */ }

  const body = await workPage.evaluate(() => document.body?.innerText || "").catch(() => "");
  const sizeText = body.match(/Size:\s*([\d.]+\s*[KMGT]B)/i)?.[1] || null;
  const size = sizeText ? parseSize(sizeText) : null;
  const dead = /file not found|not found or deleted|deleted|removed|no such file|expired/i.test(body);

  if (dead) return { status: "offline", sizeText, size, note: "file not found or deleted" };
  if (state !== "ready") return { status: "offline", sizeText: null, size: null, note: state === "verify-timeout" ? "needs a human check first" : "no download page" };
  return { status: "online", sizeText, size, note: null };
}

// One download, restartable: handles per-file pause, scheduling hold, speed limit
// changes and the staging fallback. Everything lives on the record itself.
async function runJob(rec, ctl, emit) {
  fs.mkdirSync(STAGING, { recursive: true });
  fs.mkdirSync(LOGDIR, { recursive: true });
  const logPath = path.join(LOGDIR, `${rec.spec.filename}.log`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const waitState = () => {
    if (ctl.stopped) return "stopped";
    if (rec.userPaused) return "paused";
    if (rec.held || ctl.paused) return "held";
    return null;
  };

  while (true) {
    const w = waitState();
    if (w === "stopped") return { ok: false, reason: "stopped" };
    if (w) {
      emit({ t: "status", i: rec.i, status: w, file: rec.spec.filename, bytes: Math.max(0, rec.bytes), expected: rec.spec.expected, speed: 0 });
      await sleep(300);
      continue;
    }

    const dir = rec.staged ? STAGING : rec.spec.outDir;
    const child = spawnAria2c({ ...rec.spec, dir, limitKbps: ctl.limitKbps }, logPath);
    rec.child = child;

    let restart = false;
    const kick = () => { restart = true; try { child.kill(); } catch {} };
    rec.kick = kick;              // lets pause/hold interrupt just this one download
    ctl.hooks.add(kick);

    const track = setInterval(() => {
      const p = path.join(dir, rec.spec.filename);
      let bytes = 0;
      try { bytes = fs.statSync(p).size; } catch {}
      const speed = rec.bytes >= 0 ? Math.max(0, bytes - rec.bytes) : 0;
      rec.bytes = bytes;
      emit({ t: "progress", i: rec.i, bytes, expected: rec.spec.expected, speed, status: "downloading" });
    }, 1000);

    const code = await new Promise((res) => { child.on("error", () => res(-1)); child.on("exit", (c) => res(c)); });
    clearInterval(track);
    rec.kick = null;
    ctl.hooks.delete(kick);

    if (ctl.stopped) return { ok: false, reason: "stopped" };
    if (restart) continue; // paused, held or limit changed: loop re-evaluates

    if (code === 0) {
      const src = path.join(dir, rec.spec.filename);
      const dst = path.join(rec.spec.outDir, rec.spec.filename);
      if (rec.staged) {
        try { moveFile(src, dst); }
        catch (e) { return { ok: false, reason: `could not move the file into place: ${e.message}` }; }
      }
      let bytes = 0;
      try { bytes = fs.statSync(dst).size; } catch {}
      return { ok: true, bytes };
    }

    const reason = readReason(logPath);
    const logText = (() => { try { return fs.readFileSync(logPath, "utf8").replace(/\x1b\[[0-9;]*m/g, ""); } catch { return ""; } })();

    if (/Invalid range header/i.test(logText) && !rec.restartedFromZero) {
      rec.restartedFromZero = true;
      for (const f of [path.join(dir, rec.spec.filename), path.join(dir, `${rec.spec.filename}.aria2`)]) {
        try { fs.unlinkSync(f); } catch {}
      }
      emit({ t: "notice", i: rec.i, message: "That server cannot resume a part file, so I am restarting this one from the beginning." });
      continue;
    }

    if (!rec.staged && /refused write access/i.test(reason || "")) {
      rec.staged = true;
      emit({ t: "notice", i: rec.i, message: "That folder refused aria2c's write access, so I'm staging the file and moving it in when it finishes." });
      continue;
    }

    return { ok: false, reason: reason || `aria2c exited with code ${code}` };
  }
}

export async function runBatch({ ctx, uiPage, links, outDir, parallel = 3, verifyTimeout = 900, check = false, emit = () => {}, control = {} }) {
  fs.mkdirSync(outDir, { recursive: true });

  const recs = links.map((l, i) => ({
    i, link: l.link, name: l.name,
    phase: "queued", held: false, userPaused: false, bytes: -1,
  }));

  control.paused = !!control.paused;
  control.limitKbps = Number(control.limitKbps) || 0;
  control.parallel = Math.max(1, Number(control.parallel) || parallel);
  control.stopped = false;
  control.hooks = control.hooks || new Set();

  const kickAll = () => { for (const h of [...control.hooks]) h(); };
  const rec = (i) => recs[i];

  control.pause = () => { control.paused = true; kickAll(); };
  control.resume = () => { control.paused = false; };
  control.setLimit = (k) => { control.limitKbps = Math.max(0, Number(k) || 0); if (!control.paused) kickAll(); };
  control.setParallel = (n) => { control.parallel = Math.max(1, Number(n) || 1); };
  control.stop = () => { control.stopped = true; kickAll(); };
  control.pauseJob = (i) => { const r = rec(i); if (r) { r.userPaused = true; if (r.kick) r.kick(); } };
  control.resumeJob = (i) => { const r = rec(i); if (r) { r.userPaused = false; } };

  // Everything is listed immediately, so you can see the whole queue from the start.
  for (const r of recs) emit({ t: "queued", i: r.i, name: r.name, link: r.link });

  let workPage = await ctx.newPage();
  // Resolving MUST be one at a time: every link shares this tab, so two concurrent
  // resolutions navigate over each other and capture the wrong file URL. Downloads
  // still run in parallel — only the browser step is serialised.
  let resolveLock = Promise.resolve();
  const oneAtATime = (fn) => {
    const run = resolveLock.then(fn, fn);
    resolveLock = run.then(() => {}, () => {});
    return run;
  };
  const liveWorkPage = async () => {
    if (workPage.isClosed()) workPage = await ctx.newPage();
    return workPage;
  };

  const isRunning = (r) => r.phase === "resolving" || r.phase === "downloading";
  const counted = () => recs.filter((r) => isRunning(r) && !r.held && !r.userPaused).length;
  const results = [];
  const seenUrls = new Map(); // resolved file URL -> link index that produced it

  async function startRec(r) {
    r.phase = "resolving";
    emit({ t: "status", i: r.i, status: "resolving", name: r.name, link: r.link });
    try {
      const wp = await liveWorkPage();
      const res = await oneAtATime(() => resolveOne({ ctx, workPage: wp, uiPage, link: r.link, verifyTimeout, emit }));

      if (!res.fileUrl) {
        r.phase = "failed";
        emit({ t: "status", i: r.i, status: res.state, sizeText: res.sizeText, note: res.note });
        results.push({ link: r.link, status: res.state, size: res.sizeText, reason: res.note });
        return;
      }

      const claimed = seenUrls.get(res.fileUrl);
      if (claimed !== undefined && claimed !== r.i) {
        r.phase = "failed";
        emit({ t: "status", i: r.i, status: "failed", note: `same file as link ${claimed + 1} — that page did not change, so this would download a duplicate` });
        results.push({ link: r.link, status: "failed", reason: `duplicate of link ${claimed + 1}` });
        return;
      }
      seenUrls.set(res.fileUrl, r.i);

      const filename = r.name || res.suggested || `file-${r.i + 1}`;
      const target = path.join(outDir, filename);

      if (check) {
        r.phase = "done";
        emit({ t: "status", i: r.i, status: "online", sizeText: res.sizeText, file: filename, expected: res.size });
        results.push({ link: r.link, status: "online", file: filename, size: res.sizeText });
        return;
      }

      if (fs.existsSync(target) && !fs.existsSync(`${target}.aria2`)) {
        r.phase = "done";
        emit({ t: "status", i: r.i, status: "exists", sizeText: res.sizeText, file: filename, expected: res.size });
        results.push({ link: r.link, status: "exists", file: target, size: res.sizeText });
        return;
      }

      const cookies = (await ctx.cookies(res.fileUrl)).map((c) => `${c.name}=${c.value}`).join("; ");
      const ua = await wp.evaluate(() => navigator.userAgent).catch(() => "");

      r.spec = {
        outDir, filename, fileUrl: res.fileUrl, expected: res.size,
        headers: { "User-Agent": ua, Referer: res.referer || r.link, Cookie: cookies },
      };
      r.bytes = -1;
      r.phase = "downloading";
      emit({ t: "status", i: r.i, status: "downloading", sizeText: res.sizeText, file: filename, expected: res.size, link: r.link, bytes: 0 });

      const d = await runJob(r, control, emit);
      r.phase = d.ok ? "done" : (d.reason === "stopped" ? "stopped" : "failed");
      emit({ t: "done", i: r.i, file: filename, bytes: d.bytes || Math.max(0, r.bytes), ok: d.ok, reason: d.ok ? null : d.reason });
      results.push({ link: r.link, status: d.ok ? "downloaded" : r.phase, file: target, size: res.sizeText, reason: d.reason });
    } catch (e) {
      r.phase = "failed";
      emit({ t: "status", i: r.i, status: "failed", note: `browser: ${e.message}`.slice(0, 160) });
      results.push({ link: r.link, status: "failed", reason: e.message });
    }
  }

  // Scheduler: keeps exactly control.parallel files going, and reacts to changes.
  while (!control.stopped && recs.some((r) => isRunning(r) || r.phase === "queued")) {
    if (control.paused) {
      for (const r of recs) if (isRunning(r)) r.held = true;
    } else {
      for (const r of recs) {
        if (r.held && !r.userPaused && isRunning(r) && counted() < control.parallel) r.held = false;
      }
      const over = counted() - control.parallel;
      if (over > 0) {
        const victims = recs.filter((r) => r.phase === "downloading" && !r.held && !r.userPaused).slice(-over);
        for (const v of victims) { v.held = true; if (v.kick) v.kick(); }
      }
      for (const r of recs) {
        if (r.phase === "queued" && !control.paused && counted() < control.parallel) startRec(r);
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  for (const r of recs) {
    if (r.phase === "queued" || isRunning(r)) results.push({ link: r.link, status: r.phase === "queued" ? "never started" : "stopped", reason: "batch ended" });
  }

  await workPage.close().catch(() => {});

  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  emit({ t: "summary", counts, results });

  // Warn when a multi-volume set looks incomplete, or when a part is missing.
  // Emitted after the summary so the UI can attach it without being overwritten.
  const volumes = {};
  for (const r of results) {
    if (!(r.status === "downloaded" || r.status === "exists")) continue;
    const n = path.basename(r.file || "");
    const m = /^(.*?)[._-]?part[._-]?(\d+)\.(rar|r\d\d|bin|001)$/i.exec(n);
    if (!m) continue;
    (volumes[m[1].toLowerCase()] = volumes[m[1].toLowerCase()] || []).push(Number(m[2]));
  }
  const sets = Object.entries(volumes).map(([name, nums]) => {
    const parts = [...new Set(nums)].sort((a, b) => a - b);
    const gaps = [];
    for (let i = parts[0]; i <= parts[parts.length - 1]; i++) if (!parts.includes(i)) gaps.push(i);
    return { base: name, parts, gaps };
  });

  // Catch identical files even when the URLs differed (safety net).
  const bySize = {};
  for (const r of results) {
    if (!(r.status === "downloaded" || r.status === "exists") || !r.file) continue;
    let size = 0; try { size = fs.statSync(r.file).size; } catch { continue; }
    (bySize[size] = bySize[size] || []).push(r.file);
  }
  const dupes = [];
  for (const [size, files] of Object.entries(bySize)) {
    if (files.length < 2 || Number(size) < 1024) continue;
    const head = (f) => {
      const fd = fs.openSync(f, "r");
      try { const b = Buffer.alloc(65536); const n = fs.readSync(fd, b, 0, 65536, 0); return require("crypto").createHash("sha256").update(b.subarray(0, n)).digest("hex"); }
      finally { fs.closeSync(fd); }
    };
    const hashes = new Map();
    for (const f of files) {
      let h; try { h = head(f); } catch { continue; }
      if (hashes.has(h)) dupes.push([hashes.get(h), f]);
      else hashes.set(h, f);
    }
  }
  if (dupes.length) emit({ t: "dupefiles", pairs: dupes.map(([a, b]) => [path.basename(a), path.basename(b)]) });
  if (sets.length) emit({ t: "partset", sets });

  return results;
}


