// herdr-latex helpers: the tab's machine and folder, the tab's micro (from
// herdr-micro), and moving micro to a file and line.

import { exec, hc, home, panes, spaces, terminals } from "herdr";

export const MOD = "herdr-latex";
export const LATEXMK = "herdr-latex.tab"; // label on the tab's latexmk terminal

const live = (t) => t.state === "live";
export const dirname = (p) => p.replace(/\/[^/]*$/, "") || "/";
export const basename = (p) => p.split("/").pop();

export function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

// The machine a tab lives on (null: this one).
export function machineOf(tab) {
  return spaces().find((s) => s.tabs.some((t) => t.id === tab))?.machine ?? null;
}

// The tab is the one on screen.
export function onScreen(tab) {
  return spaces().some((s) => s.active && s.tabs.some((t) => t.id === tab && t.active));
}

// The tab's micro (herdr-micro's terminal), or null.
export function microOf(tab) {
  return terminals().find((t) => live(t) && t.labels?.["herdr-micro.tab"] === tab) ?? null;
}

export function latexmkOf(tab) {
  return terminals().find((t) => live(t) && t.labels?.[LATEXMK] === tab) ?? null;
}

export function shownPane(address) {
  return panes().find((p) => p.terminal === address) ?? null;
}

export function latexPane(tab) {
  return panes().find((p) => p.mod === MOD && p.tab === tab) ?? null;
}

// Where the tab works: the focused terminal's folder, else its first one's.
export function tabCwd(tab, f = null) {
  if (f?.tab === tab && f.terminal && f.cwd) return f.cwd;
  return panes().find((p) => p.tab === tab && p.terminal && p.cwd)?.cwd ?? null;
}

// The tab's project folder: herdr-micro's root, else the git repo of the
// tab's folder, else that folder (else the machine's home).
export async function tabRoot(tab, on) {
  const label = microOf(tab)?.labels?.["herdr-micro.root"];
  if (label) return label;
  let dir = tabCwd(tab);
  if (!dir && on) dir = (await exec("sh", ["-c", "pwd"], { on }).catch(() => null))?.stdout.trim();
  dir = dir || home();
  const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: dir, on }).catch(() => null);
  return (r?.code === 0 && r.stdout.trim()) || dir;
}

export async function waitFor(cx, test, ms = 4000) {
  for (const until = Date.now() + ms; Date.now() < until; ) {
    const v = test();
    if (v) return v;
    await cx.sleep(30);
  }
  return test();
}

const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

// One micro command: Esc, Ctrl-E, the command pasted and submitted. The
// pauses matter: Esc right before Ctrl-E reads as Alt+Ctrl+E, and a paste
// before the command bar is up lands in the buffer.
async function microCommand(cx, address, command) {
  await hc(["keys", address, "esc"]);
  await cx.sleep(120);
  await hc(["keys", address, "ctrl+e"]);
  await cx.sleep(120);
  await hc(["send", "--force", address, command]);
}

// micro on `file` at `line`: opened only when its status line shows another
// file (opening the same one again would ask to save unsaved edits).
export async function microAt(cx, address, file, line) {
  const screen = (await hc(["read", address, "--lines", "3"]).catch(() => null))?.stdout ?? "";
  if (!screen.includes(`${file} `)) {
    await microCommand(cx, address, `open ${quote(file)}`);
    await cx.sleep(150);
  }
  if (line) await microCommand(cx, address, `goto ${line}`);
}
