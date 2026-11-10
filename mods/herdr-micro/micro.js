// herdr-micro's helpers: one micro per tab, a core terminal labelled
// `herdr-micro.tab=<tab id>` (and `herdr-micro.root=<folder>`), shown in a
// pane with the file tree pane on its right. Hiding parks micro (it keeps
// running, buffers and all); showing gives it a pane again.

import { exec, focused, hc, home, notify, panes, run, setShared, shared, spaces, terminals } from "herdr";

export const TAB = "herdr-micro.tab";
export const ROOT = "herdr-micro.root";
// The viewer (mods/herdr-micro-view) and the file it shows per tab.
export const VIEW_MOD = "herdr-micro-view";
const VIEW = "herdr-micro.view";
const VIEWABLE = /\.(png|jpe?g|gif|webp|bmp|svg|tiff?|ico|avif|heic|pdf)$/i;
export const viewable = (path) => VIEWABLE.test(path);

const live = (t) => t.state === "live";

// The tab's micro terminal (from `terminals()`), or null.
export function microOf(tab) {
  return terminals().find((t) => live(t) && t.labels?.[TAB] === tab) ?? null;
}

// The pane showing a terminal, or null (parked).
export function shownPane(address) {
  return panes().find((p) => p.terminal === address) ?? null;
}

// The tab's tree pane, or null.
export function treePane(tab) {
  return panes().find((p) => p.mod === "herdr-micro" && p.tab === tab) ?? null;
}

// The tab's viewer pane, or null.
export function viewPane(tab) {
  return panes().find((p) => p.mod === VIEW_MOD && p.tab === tab) ?? null;
}

// Whether the tab's pair (micro, or the viewer in its place, or the tree)
// is on screen.
export function pairShown(tab) {
  const m = microOf(tab);
  return Boolean((m && shownPane(m.address)) || treePane(tab) || viewPane(tab));
}

// The git repo a folder is in, else the folder (else home).
export async function rootFor(cwd) {
  const dir = cwd || home();
  const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: dir }).catch(() => null);
  const top = r?.code === 0 ? r.stdout.trim() : "";
  return top || dir;
}

// Where the tab works: the focused terminal's folder, else its first one's.
export function tabCwd(f) {
  if (f.terminal && f.cwd) return f.cwd;
  return panes().find((p) => p.tab === f.tab && p.terminal && p.cwd)?.cwd ?? null;
}

// The folder the tab's micro is rooted at, or the one it would be.
export async function tabRoot(f) {
  return microOf(f.tab)?.labels?.[ROOT] ?? (await rootFor(tabCwd(f)));
}

// `terminals()` and `panes()` follow commands a moment later: poll briefly.
async function waitFor(cx, test, ms = 4000) {
  for (const until = Date.now() + ms; Date.now() < until; ) {
    const v = test();
    if (v) return v;
    await cx.sleep(30);
  }
  return test();
}

const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

// Opens a file in a running micro: Esc (out of any prompt), Ctrl-E (the
// command bar), then `open '<path>'` pasted and submitted. The pauses
// matter: Esc right before Ctrl-E reads as one Alt+Ctrl+E, and a paste
// before the bar is up lands in the buffer.
export async function openFile(cx, address, path) {
  await hc(["keys", address, "esc"]);
  await cx.sleep(120);
  await hc(["keys", address, "ctrl+e"]);
  await cx.sleep(120);
  await hc(["send", "--force", address, `open ${quote(path)}`]);
}

// Shows the tab's micro (starting one in the tab's repo if it has none) and
// the tree beside it; then opens `file` and gives micro the keyboard.
// `f`: the focused place, captured before any await.
export async function openPair(cx, f, { file = null } = {}) {
  const tab = f.tab;
  let m = microOf(tab);
  let root = m?.labels?.[ROOT];
  if (!m) {
    root = await rootFor(tabCwd(f));
    const r = await hc(["run", "--bg", "--json", "--cwd", root,
      "--label", `${TAB}=${tab}`, "--label", `${ROOT}=${root}`, "--", "micro"]).catch((e) => ({ stdout: "", stderr: String(e) }));
    let address = null;
    try { address = JSON.parse(r.stdout).address; } catch {}
    if (!address) {
      notify({ title: "herdr-micro: micro did not start", body: (r.stderr || r.stdout || "").trim().slice(-300), level: "error" });
      return null;
    }
    m = (await waitFor(cx, () => microOf(tab))) ?? { address, labels: {} };
  }
  const address = m.address;
  root = root ?? (await rootFor(tabCwd(f)));
  // The viewer stands in micro's place: back to micro first.
  if (viewPane(tab)) await backToMicro(cx, tab);
  if (!shownPane(address)) {
    // keep places it beside the focused pane, which is in this tab.
    run("terminal.keep", { terminal: address, place: "right" });
    if (!(await waitFor(cx, () => shownPane(address)))) {
      notify({ title: "herdr-micro", body: "micro's pane did not appear.", level: "error" });
      return null;
    }
  }
  if (!treePane(tab)) {
    run("pane.split", { direction: "right", pane: shownPane(address).pane, mod: "herdr-micro",
      props: { role: "tree", tab, root } });
    await waitFor(cx, () => treePane(tab));
  }
  if (file) await openFile(cx, address, file);
  run("pane.focus", { terminal: address });
  return address;
}

// Shows an image or PDF in the tab's viewer, in micro's place: the viewer
// splits off micro's pane, then micro is parked (still running).
export async function viewFile(cx, f, file) {
  const tab = f.tab;
  const all = shared(VIEW) ?? {};
  setShared(VIEW, { ...all, [tab]: { file, n: (all[tab]?.n ?? 0) + 1 } });
  let vp = viewPane(tab);
  if (vp) return run("pane.focus", { pane: vp.pane });
  let m = microOf(tab);
  if (!m || !shownPane(m.address)) {
    if (!(await openPair(cx, f))) return;
    m = microOf(tab);
  }
  const mp = m && shownPane(m.address);
  if (!mp) return;
  run("pane.split", { direction: "right", pane: mp.pane, mod: VIEW_MOD, props: { tab } });
  vp = await waitFor(cx, () => viewPane(tab));
  if (!vp) return;
  run("terminal.park", { terminal: m.address });
  run("pane.focus", { pane: vp.pane });
}

// From the viewer back to micro, in the viewer's place.
export async function backToMicro(cx, tab) {
  const vp = viewPane(tab);
  const m = microOf(tab);
  if (!vp) return;
  if (m && !shownPane(m.address)) {
    // keep goes beside the focused pane: the viewer's.
    run("pane.focus", { pane: vp.pane });
    await waitFor(cx, () => focused()?.pane === vp.pane, 1500);
    run("terminal.keep", { terminal: m.address, place: "right" });
    await waitFor(cx, () => shownPane(m.address));
  }
  if (m) run("pane.focus", { terminal: m.address });
  run("pane.close", { pane: vp.pane });
  await waitFor(cx, () => !viewPane(tab), 1500);
}

// Hides the pair: the tree and viewer panes close, micro is parked (still
// running).
export function closePair(tab) {
  const tp = treePane(tab);
  if (tp) run("pane.close", { pane: tp.pane });
  const vp = viewPane(tab);
  if (vp) run("pane.close", { pane: vp.pane });
  const m = microOf(tab);
  if (m && shownPane(m.address)) run("terminal.park", { terminal: m.address });
}

// Ends micros whose tab is gone (a parked micro has no pane to close it).
export async function sweep() {
  const all = spaces();
  if (!all.length) return;
  const tabs = new Set(all.flatMap((s) => s.tabs.map((t) => t.id)));
  for (const t of terminals()) {
    const tab = t.labels?.[TAB];
    if (live(t) && tab && !tabs.has(tab)) await hc(["kill", t.address]).catch(() => null);
  }
}
