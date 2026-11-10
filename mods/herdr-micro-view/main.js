// herdr-micro-view: an image or PDF viewer pane, in the tab's micro's place.
// herdr-micro opens it (props {tab}) and tells it which file to show through
// shared "herdr-micro.view" ({[tab]: {file, n}}); micro is parked meanwhile.
// Esc / q / the "micro" button bring micro back where the viewer was.
//
// A mod can only draw images inside the app home, so the file is copied
// (images) or rendered page by page with pdftoppm (PDFs) into this mod's
// .cache folder. It reloads when the file changes.
//
// In a space on another machine the file is there: the programs run there
// (`exec {on}`) and send the bytes back as base64 (at most ~6 MB each: exec
// output stops at 8 MiB).

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, VirtualListScrollHandle, v_virtual_list } from "gpui-base";
import * as fs from "fs/promises";
import { Buffer } from "buffer";
import { appHome, exec, focused, nextCommand, panes, props, run, shared, spaces, terminals, theme } from "herdr";

const VIEW = "herdr-micro.view";
const MOD = "herdr-micro-view";
const CACHE = `mods/${MOD}/.cache`;
const CONVERT = new Set(["tif", "tiff", "bmp", "ico", "heic", "avif"]); // drawn from a PNG copy
const MAX_FETCH = 6 * 1024 * 1024;
const basename = (p) => p.split("/").pop();
const extOf = (p) => (/\.([^./]+)$/.exec(p)?.[1] ?? "").toLowerCase();

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

// The tab's micro (herdr-micro's label) and its pane, if shown.
const microOf = (tab) => terminals().find((t) => t.state === "live" && t.labels?.["herdr-micro.tab"] === tab) ?? null;
const shownPane = (address) => panes().find((p) => p.terminal === address) ?? null;

export default class HerdrMicroView extends View {
  init(_props, cx) {
    this.tab = props()?.tab;
    // The tab's machine (null: this one).
    this.on = spaces().find((s) => s.tabs.some((t) => t.id === this.tab))?.machine ?? null;
    this.file = null;
    this.mtime = null;
    this.state = null; // {kind: "image", src, w, h} | {kind: "pdf", pages, aspect, rel, done} | {error}
    this.actual = false; // images: 100% instead of fit
    this.page = 0;
    this.loadSeq = 0;
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.handle.focus();
    // Cache folders nobody has touched for half a day.
    exec("find", [`${appHome()}/${CACHE}`, "-mindepth", "1", "-maxdepth", "1", "-mmin", "+720", "-exec", "rm", "-rf", "{}", "+"]).catch(() => null);
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") { this.handle.focus(); cx.notify(); }
      }
    });
    // Another file asked for (herdr-micro sets the shared value).
    const follow = (cx) => {
      const want = shared(VIEW)?.[this.tab]?.file ?? props()?.file;
      if (want && want !== this.file) {
        this.file = want;
        this.mtime = null;
        this.page = 0;
        this.actual = false;
        cx.spawn(async (cx) => this.load(cx));
      }
    };
    follow(cx);
    cx.timer.every(250, follow);
    // The file changed on disk (a plot regenerated, a PDF rebuilt): reload.
    cx.timer.every(2000, (cx) => {
      if (!this.file || this.loading) return;
      cx.spawn(async (cx) => {
        const m = await this.stat();
        if (m && this.mtime && m !== this.mtime) await this.load(cx);
      });
    });
  }

  async close() {
    this.closed = true;
    if (this.dir) await exec("rm", ["-rf", this.dir]).catch(() => null);
  }

  async stat() {
    const r = await exec("stat", ["-L", "-c", "%Y", this.file], { on: this.on }).catch(() => null);
    return r?.code === 0 ? r.stdout.trim() : null;
  }

  // Runs `script` (sh, $1.. = args) on the tab's machine; what it prints is
  // base64, written to `out` as bytes. Resolves with null, or what went wrong.
  async fetch(script, args, out) {
    const r = await exec("sh", ["-c", `${script} | base64 -w0`, "herdr-micro", ...args], { on: this.on }).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
    if (r.code !== 0 || !r.stdout) return (r.stderr || "Could not fetch the file.").trim();
    await fs.writeFile(out, Buffer.from(r.stdout.trim(), "base64"));
    return null;
  }

  // Whether the file is small enough to fetch from another machine.
  async fits(file) {
    const r = await exec("stat", ["-L", "-c", "%s", file], { on: this.on }).catch(() => null);
    const size = Number(r?.stdout.trim() ?? 0);
    return size <= MAX_FETCH ? null : `Too big to fetch from ${this.on} (${(size / 1048576).toFixed(1)} MB; at most 6 MB).`;
  }

  async load(cx) {
    const seq = ++this.loadSeq;
    const file = this.file;
    this.loading = true;
    try {
      const mtime = await this.stat();
      if (seq !== this.loadSeq) return;
      if (!mtime) { this.state = { error: "The file is gone." }; return cx.notify(); }
      const key = hash(`${file}:${mtime}`);
      const rel = `${CACHE}/${key}`, dir = `${appHome()}/${rel}`;
      await exec("mkdir", ["-p", dir]);
      const old = this.dir;
      this.dir = dir;
      this.mtime = mtime;
      if (old && old !== dir) exec("rm", ["-rf", old]).catch(() => null);
      const ext = extOf(file);
      if (ext === "pdf") return await this.loadPdf(cx, seq, file, rel, dir);
      let src = `${rel}/image.${ext}`;
      let error = null;
      if (this.on) {
        error = await this.fits(file);
        if (!error && CONVERT.has(ext)) { src = `${rel}/image.png`; error = await this.fetch('magick "$1[0]" png:-', [file], `${appHome()}/${src}`); }
        else if (!error) error = await this.fetch('cat "$1"', [file], `${appHome()}/${src}`);
      } else {
        const r = CONVERT.has(ext)
          ? await exec("magick", [`${file}[0]`, `${dir}/image.png`]).then((r) => { src = `${rel}/image.png`; return r; })
          : await exec("cp", [file, `${dir}/image.${ext}`]);
        if (r.code !== 0) error = (r.stderr || "Could not read the image.").trim();
      }
      if (seq !== this.loadSeq) return;
      if (error) { this.state = { error }; return cx.notify(); }
      const id = await exec("magick", ["identify", "-format", "%w %h\\n", `${file}[0]`], { on: this.on }).catch(() => null);
      const [w, h] = (id?.stdout ?? "").trim().split(/\s+/).map(Number);
      if (seq !== this.loadSeq) return;
      this.state = { kind: "image", src, w: w || null, h: h || null };
      cx.notify();
    } finally {
      if (seq === this.loadSeq) this.loading = false;
    }
  }

  async loadPdf(cx, seq, file, rel, dir) {
    const info = await exec("pdfinfo", [file], { on: this.on }).catch(() => null);
    if (seq !== this.loadSeq) return;
    const pages = Number(/^Pages:\s+(\d+)/m.exec(info?.stdout ?? "")?.[1] ?? 0);
    const size = /^Page size:\s+([\d.]+) x ([\d.]+)/m.exec(info?.stdout ?? "");
    if (!pages) { this.state = { error: (info?.stderr || "Could not read the PDF.").trim() }; return cx.notify(); }
    const s = { kind: "pdf", pages, aspect: size ? Number(size[2]) / Number(size[1]) : 1.294, rel, done: new Set() };
    this.state = s;
    this.page = Math.min(this.page, pages - 1);
    cx.notify();
    // Pages render one at a time: the one being looked at (and the next two)
    // first, then the rest in order.
    for (;;) {
      if (this.closed || seq !== this.loadSeq) return;
      let next = -1;
      for (let i = this.page; i < Math.min(pages, this.page + 3); i++) if (!s.done.has(i)) { next = i; break; }
      if (next < 0) for (let i = 0; i < pages; i++) if (!s.done.has(i)) { next = i; break; }
      if (next < 0) return;
      if (this.on) {
        await this.fetch('pdftoppm -png -singlefile -f "$2" -l "$2" -scale-to-x 1600 -scale-to-y -1 "$1"',
          [file, `${next + 1}`], `${dir}/p${next + 1}.png`).catch(() => null);
      } else {
        await exec("pdftoppm", ["-png", "-singlefile", "-f", `${next + 1}`, "-l", `${next + 1}`,
          "-scale-to-x", "1600", "-scale-to-y", "-1", file, `${dir}/p${next + 1}`]).catch(() => null);
      }
      if (seq !== this.loadSeq) return;
      s.done.add(next);
      cx.notify();
    }
  }

  // micro back in this pane's place, then this pane goes.
  back(cx) {
    cx.spawn(async (cx) => {
      const me = panes().find((p) => p.mod === MOD && p.tab === this.tab);
      const m = microOf(this.tab);
      if (!me) return;
      if (m && !shownPane(m.address)) {
        // keep goes beside the focused pane: this one.
        run("pane.focus", { pane: me.pane });
        for (const until = Date.now() + 1500; focused()?.pane !== me.pane && Date.now() < until; ) await cx.sleep(30);
        run("terminal.keep", { terminal: m.address, place: "right" });
        for (const until = Date.now() + 4000; !shownPane(m.address) && Date.now() < until; ) await cx.sleep(30);
      }
      if (m) run("pane.focus", { terminal: m.address });
      run("pane.close", { pane: me.pane });
    });
  }

  // The system's app for the file, here; one on another machine is fetched
  // into the cache first.
  openExternal(cx) {
    const file = this.file, dir = this.dir;
    if (!file) return;
    if (!this.on) return void exec("xdg-open", [file]).catch(() => null);
    if (!dir) return;
    cx.spawn(async () => {
      const copy = `${dir}/${basename(file)}`;
      const error = (await this.fits(file)) ?? (await this.fetch('cat "$1"', [file], copy));
      if (!error) await exec("xdg-open", [copy]).catch(() => null);
    });
  }

  goPage(i, cx) {
    const s = this.state;
    if (s?.kind !== "pdf") return;
    this.page = Math.max(0, Math.min(s.pages - 1, i));
    this.scroll.scroll_to_item(this.page);
    cx.notify();
  }

  key(e, cx) {
    const plain = !e.modifiers.control && !e.modifiers.alt && !e.modifiers.platform;
    const k = plain && e.key_char && e.key_char.trim() ? e.key_char : e.keystroke;
    switch (k) {
      case "q": case "escape": this.back(cx); break;
      case "j": case "n": case "down": case "space": case "pagedown": this.goPage(this.page + 1, cx); break;
      case "k": case "p": case "up": case "pageup": this.goPage(this.page - 1, cx); break;
      case "g": case "home": this.goPage(0, cx); break;
      case "G": case "end": this.goPage(Infinity, cx); break;
      case "z": this.actual = !this.actual; cx.notify(); break;
      case "o": this.openExternal(cx); break;
      default: return;
    }
    cx.stop_propagation();
  }

  button(id, label, t, onClick) {
    return div().id(id).flex_none().px(8).h(22).flex().items_center().rounded(11).border_1().border_color(t.border)
      .text_size(11.5).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => onClick(cx))
      .child(label);
  }

  imageBody(s, t) {
    if (this.actual && s.w && s.h) {
      return div().id("herdr-micro-view-scroll").flex_1().min_h(0).w_full().overflow_scroll().p(14)
        .child(image(s.src).w(s.w).h(s.h).flex_none());
    }
    return div().flex_1().min_h(0).w_full().p(14).child(image(s.src).size_full());
  }

  pdfBody(s, t) {
    const W = Math.max(120, (this.size?.width ?? 700) - 40);
    const H = Math.round(W * s.aspect);
    return div().relative().flex_1().min_h(0).w_full()
      .child(v_virtual_list("herdr-micro-pdf", s.pages, H + 14, (i) => `p${i}`,
        (range) => {
          const out = [];
          for (let i = range.start; i < range.end; i++) {
            out.push(h_flex().id(`page-${i}`).w_full().h(H + 14).flex_none().justify_center().pt(14)
              .child(s.done.has(i)
                ? div().w(W).h(H).bg("#ffffff").child(image(`${s.rel}/p${i + 1}.png`).size_full())
                : div().w(W).h(H).bg(t.surface).flex().items_center().justify_center().text_color(t.dim).text_size(12).child(`Page ${i + 1}…`)));
          }
          return out;
        }).track_scroll(this.scroll).size_full())
      .child(Scrollbar.vertical("herdr-micro-pdf").absolute().inset_0());
  }

  render() {
    const t = theme();
    const s = this.state;
    const focusedNow = this.handle.is_focused();
    const body = !s
      ? div().flex_1().m_auto().text_color(t.dim).child(this.file ? "Loading…" : "Nothing to show")
      : s.error
        ? div().flex_1().p(20).text_color(t.dim).child(s.error)
        : s.kind === "pdf" ? this.pdfBody(s, t) : this.imageBody(s, t);
    const info = !s || s.error ? "" : s.kind === "pdf"
      ? `page ${this.page + 1} / ${s.pages}`
      : s.w ? `${s.w}×${s.h}${this.actual ? " · 100%" : " · fit"}` : "";
    return v_flex().id("root").size_full().min_h(0).bg(t.canvas ?? t.background).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", () => this.handle.focus())
      .child(h_flex().h(34).flex_none().px(12).gap(8).items_center().bg(t.background).border_b(1).border_color(focusedNow ? t.accent : t.border)
        .child(div().flex_none().font_semibold().child("Preview"))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(this.file ? basename(this.file) : ""))
        .child(div().flex_none().text_size(11.5).text_color(t.dim).child(info))
        .when(s?.kind === "image" && Boolean(s.w), (el) => el.child(this.button("zoom", this.actual ? "Fit" : "100%", t, (cx) => { this.actual = !this.actual; cx.notify(); })))
        .child(this.button("ext", "Open", t, (cx) => this.openExternal(cx)))
        .child(this.button("back", "micro", t, (cx) => this.back(cx))))
      .child(body)
      .child(div().flex_none().px(10).py(5).border_t(1).border_color(t.border).bg(t.background).text_size(10.5).text_color(t.dim).truncate()
        .child(s?.kind === "pdf" ? "j/k page · g/G first/last · o open externally · q micro" : "z fit/100% · o open externally · q micro"));
  }
}
