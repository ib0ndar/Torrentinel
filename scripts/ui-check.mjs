// Layout check for the web interface: builds dist/public when it is older than the sources (or with
// --build), starts the fictional UI fixture (scripts/ui-fixture.ts), signs in and checks every main page
// at phone, tablet and desktop widths, and again in Russian on a phone: no horizontal overflow, a visible
// h1, the mobile bottom bar clear of the last control, a search placeholder that fits, and no page errors,
// failed requests or error notifications. Screenshots go to output/ui-check/; exits non-zero on failure.
//
//   npm run check:ui [-- --build] [-- --port=9878]      UI_CHECK_CHANNEL=chrome uses an installed Chrome
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "patchright";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputDir = resolve(root, "output/ui-check");
const argument = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const port = Number(argument("port") ?? process.env.UI_CHECK_PORT ?? 9878);
const base = `http://127.0.0.1:${port}`;
const WIDTHS = [320, 390, 768, 1024, 1440];
const HEIGHTS = { 320: 640, 390: 844, 768: 1024, 1024: 768, 1440: 900 };
// The Russian pass repeats every page at 390 px; the expected headings are the English ones.
const ROUTES = [
  { name: "monitor", path: "/collections/series", heading: "Series 2026" },
  { name: "monitor-paged", path: "/collections/archive", heading: "Archive" },
  { name: "activity", path: "/activity", heading: "Activity" },
  { name: "settings", path: "/settings", heading: "Settings" },
  { name: "admin-overview", path: "/admin/overview", heading: "Administration" },
  { name: "admin-users", path: "/admin/users", heading: "Administration" },
  { name: "admin-mirrors", path: "/admin/mirrors", heading: "Administration" },
  { name: "admin-diagnostics", path: "/admin/diagnostics", heading: "Administration" },
];

function newestSource(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return Math.max(0, ...readdirSync(path).map((name) => newestSource(join(path, name))));
}
function ensureBuild() {
  const index = resolve(root, "dist/public/index.html");
  const sources = ["src", "public", "index.html", "vite.config.ts", "package.json"].map((path) => resolve(root, path)).filter(existsSync);
  const stale = !existsSync(index) || statSync(index).mtimeMs < Math.max(...sources.map(newestSource));
  if (!stale && !process.argv.includes("--build")) { console.log("Using the existing dist/public build."); return; }
  console.log("Building the web interface (vite build)…");
  const result = spawnSync(process.execPath, [resolve(root, "node_modules/vite/bin/vite.js"), "build", "--logLevel", "warn"], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error("vite build failed");
}
async function reachable() {
  try { await fetch(`${base}/api/auth/me`); return true; } catch { return false; }
}
async function startFixture() {
  if (await reachable()) throw new Error(`Port ${port} is already in use; stop that server or pass --port=<port>`);
  const fixture = spawn(process.execPath, ["--import", "tsx", resolve(root, "scripts/ui-fixture.ts"), `--port=${port}`], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  fixture.stdout.on("data", (chunk) => { log += chunk; });
  fixture.stderr.on("data", (chunk) => { log += chunk; });
  const exited = new Promise((done) => fixture.once("exit", done));
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (fixture.exitCode !== null) throw new Error(`The UI fixture exited:\n${log}`);
    if (await reachable()) return { stop: async () => { if (fixture.exitCode === null) { fixture.kill("SIGTERM"); await exited; } } };
    await new Promise((done) => setTimeout(done, 200));
  }
  fixture.kill("SIGTERM");
  throw new Error(`The UI fixture did not start on port ${port}:\n${log}`);
}

// Runs in the page: overflow, heading, bottom bar and the collection search placeholder.
function measure(expectedHeading) {
  const tolerance = 1, root = document.documentElement;
  const failures = [];
  const overflow = Math.max(root.scrollWidth, document.body.scrollWidth) - root.clientWidth;
  if (overflow > tolerance) {
    // Elements reaching past the edge, minus in-flow content clipped by an ancestor (likely culprits first).
    const clipped = (element) => getComputedStyle(element).position !== "absolute" && [...function* () { for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) yield node; }()]
      .some((ancestor) => getComputedStyle(ancestor).overflowX !== "visible" && ancestor.getBoundingClientRect().right <= root.clientWidth + tolerance);
    const wide = [...document.querySelectorAll(".app-stage *")].filter((element) => element.getBoundingClientRect().right > root.clientWidth + tolerance && getComputedStyle(element).position !== "fixed" && !clipped(element))
      .slice(0, 3).map((element) => `${element.tagName.toLowerCase()}.${[...element.classList].join(".")}`);
    failures.push(`horizontal overflow of ${overflow}px (${wide.join(", ") || "unknown element"})`);
  }
  window.scrollTo(0, 0);
  const heading = [...document.querySelectorAll(".app-stage h1")].find((element) => element.getClientRects().length);
  if (!heading || !heading.textContent.trim()) failures.push("no visible h1");
  else {
    const box = heading.getBoundingClientRect(), hit = document.elementFromPoint(Math.min(box.left + 8, innerWidth - 1), box.top + box.height / 2);
    if (box.top < 0 || box.bottom > innerHeight) failures.push(`h1 outside the first screen (${Math.round(box.top)}–${Math.round(box.bottom)}px)`);
    else if (!hit || !heading.contains(hit)) failures.push(`h1 covered by ${hit ? hit.className || hit.tagName : "nothing"}`);
    if (expectedHeading && heading.textContent.trim() !== expectedHeading) failures.push(`h1 is "${heading.textContent.trim()}", expected "${expectedHeading}"`);
  }
  const bar = document.querySelector(".app-nav");
  const fixedBar = bar && getComputedStyle(bar).position === "fixed" ? bar : null;
  let lastControl = null;
  if (fixedBar) {
    window.scrollTo(0, root.scrollHeight);
    const focusable = [...document.querySelectorAll('.app-stage :is(a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"]))')]
      .filter((element) => !element.disabled && element.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
    const last = focusable.reduce((lowest, element) => !lowest || element.getBoundingClientRect().bottom >= lowest.getBoundingClientRect().bottom ? element : lowest, null);
    if (last) {
      const box = last.getBoundingClientRect(), barTop = fixedBar.getBoundingClientRect().top;
      const label = last.getAttribute("aria-label") || (last.tagName === "SELECT" ? last.selectedOptions[0]?.textContent : last.labels?.[0]?.textContent || last.textContent) || last.value || "";
      lastControl = `${last.tagName.toLowerCase()} "${label.trim().slice(0, 40)}"`;
      if (box.bottom > barTop + tolerance) { failures.push(`the bottom bar covers the last control ${lastControl} (${Math.round(box.bottom)}px > ${Math.round(barTop)}px)`); lastControl = null; }
    }
    window.scrollTo(0, 0);
  }
  const search = document.querySelector(".search-box input");
  let placeholder = null;
  if (search?.placeholder) {
    const style = getComputedStyle(search), context = document.createElement("canvas").getContext("2d");
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const text = Math.ceil(context.measureText(search.placeholder).width), room = Math.floor(search.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    placeholder = `"${search.placeholder}" ${text}/${room}px`;
    if (text > room) failures.push(`search placeholder cut off: ${placeholder}`);
  }
  const errorToasts = [...document.querySelectorAll(".toast--bad")].map((toast) => toast.textContent.trim());
  if (errorToasts.length) failures.push(`error notification: ${errorToasts.join(" | ")}`);
  return { failures, lastControl, placeholder };
}

async function settle(page) {
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => !document.querySelector(".skeleton, .boot-screen") && document.querySelector(".app-shell"), null, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
}

async function checkPage(browser, storageState, { width, language, route }) {
  const context = await browser.newContext({ viewport: { width, height: HEIGHTS[width] }, storageState, reducedMotion: "reduce", locale: language === "ru" ? "ru-RU" : "en-US" });
  const page = await context.newPage(), problems = [];
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") problems.push(`console error: ${message.text()}`); });
  page.on("response", (response) => { if (response.status() >= 400) problems.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`); });
  try {
    await page.goto(base + route.path);
    await settle(page);
    const result = await page.evaluate(measure, language === "en" ? route.heading : null);
    const file = join(outputDir, `${language}-${width}-${route.name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return { ...result, failures: [...problems, ...result.failures], file };
  } finally { await context.close(); }
}

async function main() {
  ensureBuild();
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  const fixture = await startFixture();
  let browser;
  const stop = async () => { await browser?.close().catch(() => undefined); await fixture.stop(); };
  process.once("SIGINT", () => void stop().then(() => process.exit(130)));
  try {
    const channel = process.env.UI_CHECK_CHANNEL || undefined;
    try { browser = await chromium.launch({ headless: true, channel }); }
    catch (error) { throw new Error(`Could not start ${channel || "Chromium"} with patchright. Install it with "npx patchright install chromium" or set UI_CHECK_CHANNEL=chrome.\n${error.message}`); }
    const login = await browser.newContext();
    const page = await login.newPage();
    await page.goto(base);
    await page.fill('.login-form input[autocomplete="username"]', "admin");
    await page.fill('.login-form input[autocomplete="current-password"]', "admin");
    await page.click('.login-form button[type="submit"], .login-form .button--primary');
    await page.waitForSelector(".app-shell");
    const storageState = await login.storageState();
    const setLanguage = (language) => page.request.put(`${base}/api/settings/preferences`, { data: { language } });

    const checks = [...WIDTHS.flatMap((width) => ROUTES.map((route) => ({ width, language: "en", route }))), ...ROUTES.map((route) => ({ width: 390, language: "ru", route }))];
    const results = [];
    for (const check of checks) {
      if (check.language !== (results.at(-1)?.language ?? "en")) await setLanguage(check.language);
      const result = await checkPage(browser, storageState, check);
      results.push({ ...check, ...result });
      const status = result.failures.length ? "FAIL" : "ok  ";
      const notes = [result.lastControl && `last control ${result.lastControl} clears the bottom bar`, result.placeholder && `placeholder ${result.placeholder}`].filter(Boolean);
      console.log(`${status} ${check.language} ${String(check.width).padStart(4)} ${check.route.name.padEnd(18)} ${notes.join("; ")}`.trimEnd());
      for (const failure of result.failures) console.log(`       ${failure}`);
    }
    await setLanguage("en");
    await login.close();
    const failed = results.filter((result) => result.failures.length);
    console.log(`\n${results.length - failed.length}/${results.length} page checks passed; screenshots in ${relative(root, outputDir)}/`);
    if (failed.length) process.exitCode = 1;
  } finally { await stop(); }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
