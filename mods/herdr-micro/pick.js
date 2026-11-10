// The picker: a dialog of herdr-micro with props {role: "pick", place} listing the tab's repo files,
// uncommitted changes first, then the rest newest first; typing filters
// (fuzzy). ⏎ opens the file in the tab's micro (showing it if it is hidden).

import { div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Scrollbar, VirtualListScrollHandle, v_virtual_list } from "gpui-base";
import { closeOverlay, exec, props, run, theme } from "herdr";
import { machineOf, microOf, openFile, openPair, shownPane, tabRoot, viewable, viewFile, viewPane } from "./micro.js";

const LIST = `cd "$1" || exit 1
{ git ls-files -z -co --exclude-standard 2>/dev/null || find . -type f -not -path '*/.git/*' -printf '%P\\0'; } |
  head -z -n 20000 | xargs -0 -r stat -c '%Y %n' -- 2>/dev/null | sort -rn | head -n 8000`;

function age(sec) {
  const s = Math.max(0, Date.now() / 1000 - sec);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// A subsequence match's score (lower is better), or -1.
function score(path, q) {
  const p = path.toLowerCase();
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (base.includes(q)) return base.startsWith(q) ? 0 : 1;
  if (p.includes(q)) return 2;
  let i = 0;
  for (const ch of p) if (ch === q[i]) i++;
  return i === q.length ? 3 : -1;
}

export class Pick {
  constructor(cx) {
    this.f = props()?.place ?? null;
    this.overlay = props()?.overlay;
    this.files = [];
    this.selected = 0;
    this.loading = true;
    this.scroll = VirtualListScrollHandle.new();
    this.input = InputState.new({ placeholder: "Find a file…" });
    this.input.on("change", (_e, cx) => { this.selected = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.choose(cx));
    this.input.focus();
    cx.spawn(async (cx) => {
      if (this.f?.tab) await this.load();
      this.loading = false;
      cx.notify();
    });
  }

  async load() {
    this.root = await tabRoot(this.f);
    const on = machineOf(this.f.tab);
    const [all, st] = await Promise.all([
      exec("sh", ["-c", LIST, "herdr-micro", this.root], { on }).catch(() => null),
      exec("git", ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=normal"], { cwd: this.root, on }).catch(() => null),
    ]);
    const changed = new Map();
    const parts = (st?.code === 0 ? st.stdout : "").split("\0");
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i];
      if (e.length < 4) continue;
      const xy = e.slice(0, 2);
      if (xy[0] === "R" || xy[0] === "C") i++;
      changed.set(e.slice(3), xy === "??" ? "U" : xy.includes("D") ? "D" : xy.includes("A") ? "A" : "M");
    }
    const files = [];
    for (const line of (all?.stdout ?? "").split("\n")) {
      const sp = line.indexOf(" ");
      if (sp < 0) continue;
      const path = line.slice(sp + 1).replace(/^\.\//, "");
      files.push({ path, mtime: Number(line.slice(0, sp)), mark: changed.get(path) ?? null });
    }
    // Uncommitted changes first (deleted ones have no file to open).
    files.sort((a, b) => (Boolean(b.mark) - Boolean(a.mark)) || (b.mtime - a.mtime));
    this.files = files;
  }

  list() {
    const q = this.input.value().trim().toLowerCase();
    if (!q) return this.files.slice(0, 1000);
    return this.files.map((f, i) => ({ f, i, s: score(f.path, q) })).filter((x) => x.s >= 0)
      .sort((a, b) => a.s - b.s || a.i - b.i).slice(0, 1000).map((x) => x.f);
  }

  choose(cx, row = this.list()[this.selected]) {
    if (!row || !this.f?.tab || this.choosing) return;
    this.choosing = true;
    const file = `${this.root}/${row.path}`;
    cx.spawn(async (cx) => {
      try {
        const m = microOf(this.f.tab);
        // Closing this dialog ends this task: close only once done.
        if (viewable(file)) {
          await viewFile(cx, this.f, file);
        } else if (m && shownPane(m.address) && !viewPane(this.f.tab)) {
          await openFile(cx, m.address, file);
          run("pane.focus", { terminal: m.address });
        } else {
          await openPair(cx, this.f, { file });
        }
      } finally {
        closeOverlay(this.overlay);
      }
    });
  }

  key(e, cx) {
    const n = this.list().length;
    const k = e.keystroke;
    if (k === "down" || k === "ctrl-n" || k === "ctrl-j") this.selected = Math.min(n - 1, this.selected + 1);
    else if (k === "up" || k === "ctrl-p" || k === "ctrl-k") this.selected = Math.max(0, this.selected - 1);
    else return;
    cx.stop_propagation();
    this.scroll.scroll_to_item(this.selected);
    cx.notify();
  }

  row(r, i, t) {
    const slash = r.path.lastIndexOf("/");
    const markColor = r.mark === "A" || r.mark === "U" ? t.ansi2 : r.mark === "D" ? t.ansi1 : t.blocked;
    return h_flex().id(`p-${r.path}`).h(26).flex_none().px(10).gap(8).items_center().rounded(6).cursor_pointer()
      .when(i === this.selected, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .child(div().w(12).flex_none().text_size(11).text_color(markColor).child(r.mark ?? ""))
      .child(div().flex_none().child(r.path.slice(slash + 1)))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(slash > 0 ? r.path.slice(0, slash) : ""))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(age(r.mtime)));
  }

  render() {
    const t = theme();
    const rows = this.list();
    if (this.selected >= rows.length) this.selected = Math.max(0, rows.length - 1);
    const empty = !this.f?.tab ? "Open a tab first." : this.loading ? "Listing files…" : "No match";
    return v_flex().id("herdr-micro-pick").size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => this.key(e, cx))
      .child(h_flex().h(36).flex_none().px(12).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Open in micro"))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(this.root ?? ""))
        .child(div().text_size(11).text_color(t.dim).child("↑↓ move · ⏎ open · esc close")))
      .child(div().flex_none().p(8).child(Input.new(this.input)))
      .child(rows.length === 0
        ? div().flex_1().p(14).text_size(12).text_color(t.dim).child(empty)
        : div().relative().flex_1().min_h(0).px(6).pb(6)
          .child(v_virtual_list("herdr-micro-pick", rows.length, 26, (i) => rows[i].path,
            (range) => rows.slice(range.start, range.end).map((r, k) => this.row(r, range.start + k, t)))
            .track_scroll(this.scroll).size_full()
            .on_item_click((key, cx) => {
              const at = rows.findIndex((r) => r.path === key);
              if (at >= 0) { this.selected = at; this.choose(cx, rows[at]); }
            }))
          .child(Scrollbar.vertical("herdr-micro-pick").absolute().inset_0()));
  }
}
