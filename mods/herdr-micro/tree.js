// The file tree pane beside the tab's micro. Click or ⏎ on a file opens it in
// micro (which takes the keyboard); folders open and close in place.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, VirtualListScrollHandle, v_virtual_list } from "gpui-base";
import { exec, nextCommand, props, run, theme, watchFolder } from "herdr";
import { backToMicro, microOf, openFile, treePane, viewable, viewFile, viewPane } from "./micro.js";

const HINT = "j/k move · l open · h close · ⌫ up · . root · ~ home · H hidden · q micro";
const dirname = (p) => p.replace(/\/[^/]*$/, "") || "/";
const basename = (p) => p.replace(/\/+$/, "").split("/").pop() || p;

export class Tree {
  constructor(cx) {
    const p = props();
    this.tab = p.tab;
    this.home = p.root;
    this.root = p.root;
    this.open = new Set();
    this.entries = new Map(); // folder → [{name, abs, dir}]
    this.marks = new Map(); // path → git letter (folders: "•")
    this.hidden = false; // show dotfiles
    this.selected = 0;
    this.seenMicro = false;
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    cx.spawn(async (cx) => { await this.reload(); cx.notify(); });
    // pane.go onto this pane, or a popup over it closing: take the keyboard.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") { this.handle.focus(); cx.notify(); }
      }
    });
    // Files changing under the root: list again.
    cx.spawn(async (cx) => {
      while (!this.closed) {
        const ok = await watchFolder(this.root).then(() => true, () => false);
        if (this.closed) return;
        if (!ok) await cx.sleep(5000);
        await this.reload();
        cx.notify();
      }
    });
    // micro ended (:q, Ctrl-Q): this tree goes with it.
    cx.timer.every(1000, () => {
      const m = microOf(this.tab);
      if (m) this.seenMicro = true;
      else if (this.seenMicro && !this.closing) {
        this.closing = true;
        const tp = treePane(this.tab);
        if (tp) run("pane.close", { pane: tp.pane });
      }
    });
  }

  close() {
    this.closed = true;
  }

  async list(dir) {
    const r = await exec("find", ["-L", dir, "-mindepth", "1", "-maxdepth", "1", "-printf", "%y\\t%f\\n"]).catch(() => null);
    const out = [];
    for (const line of (r?.stdout ?? "").split("\n")) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const name = line.slice(tab + 1);
      if (name === ".git") continue;
      out.push({ name, abs: dir === "/" ? `/${name}` : `${dir}/${name}`, dir: line.slice(0, tab) === "d" });
    }
    out.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true })));
    this.entries.set(dir, out);
  }

  async reload() {
    const dirs = [this.root, ...[...this.open].filter((d) => d.startsWith(`${this.root}/`))];
    await Promise.all(dirs.map((d) => this.list(d)));
    await this.git();
  }

  async git() {
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: this.root }).catch(() => null);
    const marks = new Map();
    if (top?.code === 0) {
      const base = top.stdout.trim();
      const r = await exec("git", ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=normal"], { cwd: base }).catch(() => null);
      const parts = (r?.stdout ?? "").split("\0");
      for (let i = 0; i < parts.length; i++) {
        const e = parts[i];
        if (e.length < 4) continue;
        const xy = e.slice(0, 2);
        if (xy[0] === "R" || xy[0] === "C") i++; // the original path follows
        const abs = `${base}/${e.slice(3).replace(/\/$/, "")}`;
        const letter = xy === "??" ? "U" : xy.includes("D") ? "D" : xy.includes("A") ? "A" : "M";
        marks.set(abs, letter);
        for (let d = dirname(abs); d.length > base.length && !marks.has(d); d = dirname(d)) marks.set(d, "•");
      }
    }
    this.marks = marks;
  }

  rows() {
    const out = [];
    const walk = (dir, depth) => {
      for (const e of this.entries.get(dir) ?? []) {
        if (!this.hidden && e.name.startsWith(".")) continue;
        out.push({ ...e, depth });
        if (e.dir && this.open.has(e.abs)) walk(e.abs, depth + 1);
      }
    };
    walk(this.root, 0);
    return out;
  }

  micro() {
    return microOf(this.tab)?.address ?? null;
  }

  focusMicro() {
    const m = this.micro();
    if (m) run("pane.focus", { terminal: m });
  }

  setRoot(dir, cx) {
    this.root = dir;
    this.selected = 0;
    cx.spawn(async (cx) => { await this.reload(); cx.notify(); });
  }

  toggleDir(row, cx) {
    if (this.open.has(row.abs)) this.open.delete(row.abs);
    else {
      this.open.add(row.abs);
      if (!this.entries.has(row.abs)) cx.spawn(async (cx) => { await this.list(row.abs); cx.notify(); });
    }
  }

  activate(row, cx) {
    if (!row) return;
    if (row.dir) return this.toggleDir(row, cx);
    cx.spawn(async (cx) => {
      // Images and PDFs: the viewer, in micro's place.
      if (viewable(row.abs)) return viewFile(cx, { tab: this.tab }, row.abs);
      if (viewPane(this.tab)) await backToMicro(cx, this.tab);
      const m = this.micro();
      if (!m) return;
      await openFile(cx, m, row.abs);
      run("pane.focus", { terminal: m });
    });
  }

  key(e, cx) {
    const rows = this.rows();
    const row = rows[this.selected];
    const plain = !e.modifiers.control && !e.modifiers.alt && !e.modifiers.platform;
    const k = plain && e.key_char && e.key_char.trim() ? e.key_char : e.keystroke;
    const move = (to) => { this.selected = Math.max(0, Math.min(rows.length - 1, to)); };
    switch (k) {
      case "j": case "down": move(this.selected + 1); break;
      case "k": case "up": move(this.selected - 1); break;
      case "g": case "home": move(0); break;
      case "G": case "end": move(rows.length - 1); break;
      case "l": case "enter": case "right": this.activate(row, cx); break;
      case "h": case "left": {
        if (!row) break;
        // An open folder closes; else the row's folder closes and is selected.
        if (row.dir && this.open.has(row.abs)) { this.open.delete(row.abs); break; }
        const parent = dirname(row.abs);
        if (parent === this.root) break;
        this.open.delete(parent);
        move(this.rows().findIndex((r) => r.abs === parent));
        break;
      }
      case "backspace": if (this.root !== "/") this.setRoot(dirname(this.root), cx); break;
      case ".": if (row?.dir) this.setRoot(row.abs, cx); break;
      case "~": this.setRoot(this.home, cx); break;
      case "H": this.hidden = !this.hidden; move(this.selected); break;
      case "Z": this.open.clear(); move(0); break;
      case "u": cx.spawn(async (cx) => { await this.reload(); cx.notify(); }); break;
      case "q": case "escape": this.focusMicro(); break;
      default: return;
    }
    cx.stop_propagation();
    this.scroll.scroll_to_item(this.selected);
    cx.notify();
  }

  clicked(key, cx) {
    const rows = this.rows();
    const at = rows.findIndex((r) => r.abs === key);
    if (at < 0) return;
    this.selected = at;
    this.handle.focus();
    this.activate(rows[at], cx);
    cx.notify();
  }

  row(r, i, t, focusedNow) {
    const mark = this.marks.get(r.abs);
    const markColor = mark === "A" || mark === "U" ? t.ansi2 : mark === "D" ? t.ansi1 : mark === "•" ? t.dim : t.blocked;
    return h_flex().id(`row-${r.abs}`).h(26).flex_none().pl(6 + r.depth * 14).pr(8).gap(6).items_center().rounded(6).cursor_pointer()
      .when(i === this.selected, (el) => el.bg(focusedNow ? t.selected : t.hover))
      .hover((s) => s.bg(t.hover))
      .child(r.dir ? svg(`mods/files/chevron-${this.open.has(r.abs) ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
      .child(svg(`mods/files/${r.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().text_color(r.name.startsWith(".") ? t.muted : t.foreground).child(r.name))
      .when(Boolean(mark), (el) => el.child(div().text_size(11).text_color(markColor).child(mark)));
  }

  render() {
    const t = theme();
    const rows = this.rows();
    const focusedNow = this.handle.is_focused();
    if (this.selected >= rows.length) this.selected = Math.max(0, rows.length - 1);
    const away = this.root !== this.home;
    return v_flex().id("herdr-micro-tree").size_full().min_h(0).overflow_hidden()
      .bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", () => this.handle.focus())
      .child(h_flex().h(34).flex_none().px(12).gap(8).items_center().border_b(1).border_color(focusedNow ? t.accent : t.border)
        .child(div().font_semibold().flex_none().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(basename(this.root)))
        .when(away, (el) => el.child(div().id("home").flex_none().text_size(11).text_color(t.accent).cursor_pointer()
          .child(`~ ${basename(this.home)}`).on_click((_e, cx) => { this.setRoot(this.home, cx); cx.notify(); }))))
      .child(rows.length === 0
        ? div().flex_1().p(14).text_size(12).text_color(t.dim).child(this.entries.has(this.root) ? "No files" : "Loading files…")
        : div().relative().flex_1().min_h(0).p(4)
          .child(v_virtual_list("herdr-micro-tree", rows.length, 26, (i) => rows[i].abs,
            (range) => rows.slice(range.start, range.end).map((r, k) => this.row(r, range.start + k, t, focusedNow)))
            .track_scroll(this.scroll).size_full()
            .on_item_click((key, cx) => this.clicked(key, cx)))
          .child(Scrollbar.vertical("herdr-micro-tree").absolute().inset_0()))
      .child(div().flex_none().px(10).py(5).border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim).truncate().child(HINT));
  }
}
