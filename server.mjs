// Local UI. Opens inside the Edge window that the bot controls, so the links you
// paste, the folder you pick, and any Cloudflare verify page are all one window.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launchBrowser, runBatch, parseLinks, probeOne, ensureAria2 } from "./bot.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);

const clients = new Set();
const state = {
  outDir: path.join(HERE, "downloads"),
  parallel: 3,
  running: false,
  rows: [],        // downloads table
  pending: [],     // linkgrabber list
};
const control = { paused: false, limitKbps: 0, stopped: false, parallel: 3, hooks: new Set() };
let ctx, uiPage, browser;
let nextId = 1;
let checking = false;

const send = (obj) => { const s = `data: ${JSON.stringify(obj)}\n\n`; for (const c of clients) { try { c.write(s); } catch {} } };
const hostOf = (link) => { try { return new URL(link).hostname; } catch { return ""; } };

const emit = (e) => {
  if (e.t === "queued") state.rows[e.i] = { ...(state.rows[e.i] || {}), link: e.link, name: e.name, host: hostOf(e.link), status: "queued" };
  else if (e.t === "status") state.rows[e.i] = { ...(state.rows[e.i] || {}), ...e };
  else if (e.t === "progress") state.rows[e.i] = { ...(state.rows[e.i] || {}), bytes: e.bytes, expected: e.expected, speed: e.speed, status: "downloading" };
  else if (e.t === "done") state.rows[e.i] = { ...(state.rows[e.i] || {}), status: e.ok ? "done" : "failed", bytes: e.bytes, reason: e.reason, speed: 0 };
  else if (e.t === "notice") state.rows[e.i] = { ...(state.rows[e.i] || {}), notice: e.message };
  send(e);
};

function pickFolder() {
  return new Promise((resolve) => {
    const ps = spawn("powershell", ["-NoProfile", "-STA", "-Command",
      "Add-Type -AssemblyName System.Windows.Forms | Out-Null;" +
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog;" +
      "$d.Description = 'Choose where downloaded files go';" +
      "$d.ShowNewFolderButton = $true;" +
      "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    ps.stdout.on("data", (d) => { out += d; });
    ps.on("error", () => resolve(null));
    ps.on("exit", () => resolve(out.trim() || null));
  });
}

const readBody = (req) => new Promise((resolve) => {
  let b = "";
  req.on("data", (c) => { b += c; });
  req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
});
const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const pushPending = () => send({ t: "pending", items: state.pending });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(path.join(HERE, "ui.html")));
    return;
  }

  if (url.pathname === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" });
    res.write(`data: ${JSON.stringify({ t: "init", outDir: state.outDir, parallel: state.parallel, running: state.running,
      paused: control.paused, limitKbps: control.limitKbps, rows: state.rows, pending: state.pending })}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (url.pathname === "/browse" && req.method === "POST") {
    const p = await pickFolder();
    if (p) { state.outDir = p; send({ t: "folder", outDir: p }); }
    json(res, 200, { outDir: state.outDir });
    return;
  }

  if (url.pathname === "/folder" && req.method === "POST") {
    const b = await readBody(req);
    if (b.outDir) state.outDir = String(b.outDir);
    json(res, 200, { outDir: state.outDir });
    return;
  }

  if (url.pathname === "/add" && req.method === "POST") {
    const b = await readBody(req);
    const links = Array.isArray(b.links) ? b.links.map((l) => ({ link: l, name: null })) : parseLinks(b.links || "");
    for (const l of links) {
      if (state.pending.some((p) => p.link === l.link)) continue;
      state.pending.push({ id: nextId++, link: l.link, name: l.name, host: hostOf(l.link), status: "ready", sizeText: null });
    }
    pushPending();
    json(res, 200, { count: state.pending.length });
    return;
  }

  if (url.pathname === "/remove" && req.method === "POST") {
    const b = await readBody(req);
    state.pending = state.pending.filter((p) => p.id !== Number(b.id));
    pushPending();
    json(res, 200, { count: state.pending.length });
    return;
  }

  if (url.pathname === "/clear" && req.method === "POST") {
    state.pending = [];
    pushPending();
    json(res, 200, { count: 0 });
    return;
  }

  if (url.pathname === "/check" && req.method === "POST") {
    if (checking || !ctx || state.pending.length === 0) { json(res, 200, { ok: false }); return; }
    checking = true;
    json(res, 200, { ok: true });
    (async () => {
      const wp = await ctx.newPage();
      try {
        for (const item of [...state.pending]) {
          if (item.status === "online" || item.status === "offline") continue;
          if (!state.pending.includes(item)) continue;
          send({ t: "pending-item", id: item.id, status: "checking" });
          const r = await probeOne({ ctx, workPage: wp, link: item.link, verifyTimeout: 180, emit: () => {} });
          item.status = r.status;
          item.sizeText = r.sizeText;
          item.note = r.note;
          send({ t: "pending-item", id: item.id, status: r.status, sizeText: r.sizeText, note: r.note });
        }
      } catch { /* ignore */ }
      finally { await wp.close().catch(() => {}); checking = false; send({ t: "pending-done" }); }
    })();
    return;
  }

  if (url.pathname === "/clearrows" && req.method === "POST") {
    if (state.running) { res.writeHead(409); res.end("busy"); return; }
    state.rows = [];
    send({ t: "clearrows" });
    json(res, 200, { ok: true });
    return;
  }

  if (url.pathname === "/pause" && req.method === "POST") {
    control.pause(); send({ t: "control", paused: true, limitKbps: control.limitKbps, parallel: control.parallel });
    json(res, 200, { paused: true }); return;
  }
  if (url.pathname === "/resume" && req.method === "POST") {
    control.resume(); send({ t: "control", paused: false, limitKbps: control.limitKbps, parallel: control.parallel });
    json(res, 200, { paused: false }); return;
  }
  if (url.pathname === "/limit" && req.method === "POST") {
    const b = await readBody(req);
    control.setLimit(Number(b.kbps) || 0);
    send({ t: "control", paused: control.paused, limitKbps: control.limitKbps, parallel: control.parallel });
    json(res, 200, { limitKbps: control.limitKbps }); return;
  }
  if (url.pathname === "/parallel" && req.method === "POST") {
    const b = await readBody(req);
    const n = Math.max(1, Number(b.parallel) || 1);
    if (control.setParallel) control.setParallel(n); else control.parallel = n;
    state.parallel = n;
    send({ t: "control", paused: control.paused, limitKbps: control.limitKbps, parallel: control.parallel });
    json(res, 200, { parallel: control.parallel }); return;
  }
  if (url.pathname === "/pausejob" && req.method === "POST") {
    const b = await readBody(req);
    if (control.pauseJob) control.pauseJob(Number(b.i));
    json(res, 200, { ok: true }); return;
  }
  if (url.pathname === "/resumejob" && req.method === "POST") {
    const b = await readBody(req);
    if (control.resumeJob) control.resumeJob(Number(b.i));
    json(res, 200, { ok: true }); return;
  }

  if (url.pathname === "/start" && req.method === "POST") {
    if (state.running) { res.writeHead(409); res.end("busy"); return; }
    if (!ctx) { res.writeHead(503); res.end("browser not ready"); return; }
    const b = await readBody(req);

    // Whatever is in the LinkGrabber becomes the batch; fall back to the pasted text.
    const links = state.pending.length
      ? state.pending.map((p) => ({ link: p.link, name: p.name }))
      : parseLinks(b.links || "");

    state.outDir = b.outDir || state.outDir;
    state.parallel = Math.max(1, Number(b.parallel) || state.parallel);
    state.rows = [];
    state.pending = [];
    control.paused = false;
    control.stopped = false;
    json(res, 200, { ok: true, count: links.length });
    pushPending();

    if (links.length === 0) { send({ t: "error", message: "No links to download." }); return; }
    state.running = true;
    send({ t: "started", count: links.length, outDir: state.outDir });
    try {
      await runBatch({ ctx, uiPage, links, outDir: state.outDir, parallel: state.parallel, verifyTimeout: 900, emit, control });
    } catch (e) {
      send({ t: "error", message: e.message });
    } finally {
      state.running = false;
      send({ t: "finished" });
    }
    return;
  }

  res.writeHead(404); res.end("not found");
});

server.listen(PORT, "127.0.0.1", async () => {
  console.log(`\n  Ndownloader2 UI -> http://127.0.0.1:${PORT}`);
  try { await ensureAria2(); } catch (e) { console.log("  ", e.message); }
  console.log("  Opening the browser window...");
  try {
    const r = await launchBrowser({ profileDir: path.join(HERE, ".profile"), startUrl: `http://127.0.0.1:${PORT}/`, port: 9333 });
    ctx = r.ctx; uiPage = r.page; browser = r.browser;
    await uiPage.bringToFront().catch(() => {});
    console.log("  Ready. Paste your links in that window.\n");
  } catch (e) {
    console.log("  Could not open Edge:", e.message);
    console.log(`  Open http://127.0.0.1:${PORT} in any browser instead.\n`);
  }
});
