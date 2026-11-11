// The built PDF, page by page: rendered with pdftoppm on the tab's machine
// into this mod's .cache (a mod can draw images only from inside the app
// home; from another machine the PNGs come back as base64). After a rebuild
// the previous build's pages stay up until the new ones are drawn.

import * as fs from "fs/promises";
import { Buffer } from "buffer";
import { div, image } from "gpui-kit";
import { h_flex, Scrollbar, VirtualListScrollHandle, v_virtual_list } from "gpui-base";
import { appHome, exec } from "herdr";
import { hash, MOD } from "./util.js";

const PAGE_PX = 1600;

export class PdfView {
  constructor(tab, on) {
    this.on = on;
    this.base = `mods/${MOD}/.cache/${hash(tab)}`;
    this.scroll = VirtualListScrollHandle.new();
    this.page = 0; // the page the keys moved to
    this.firstVisible = 0;
    this.gen = null; // {rel, pages, aspect, done: Set}
    this.prev = null;
    this.seq = 0;
  }

  async close() {
    await exec("rm", ["-rf", `${appHome()}/${this.base}`]).catch(() => null);
  }

  // A new build of `file` (mtime): measure it, then render its pages,
  // the ones on screen first.
  async load(cx, file, mtime) {
    const seq = ++this.seq;
    const info = await exec("pdfinfo", [file], { on: this.on }).catch(() => null);
    if (seq !== this.seq) return;
    const pages = Number(/^Pages:\s+(\d+)/m.exec(info?.stdout ?? "")?.[1] ?? 0);
    if (!pages) return;
    const size = /^Page size:\s+([\d.]+) x ([\d.]+)/m.exec(info.stdout);
    const rel = `${this.base}/${hash(`${file}:${mtime}`)}`;
    await exec("mkdir", ["-p", `${appHome()}/${rel}`]);
    const old = this.prev;
    this.prev = this.gen;
    if (old && old.rel !== this.prev?.rel) exec("rm", ["-rf", `${appHome()}/${old.rel}`]).catch(() => null);
    this.gen = { rel, pages, aspect: size ? Number(size[2]) / Number(size[1]) : 1.294, done: new Set() };
    const gen = this.gen;
    cx.notify();
    for (;;) {
      if (seq !== this.seq || this.closed) return;
      const from = Math.min(this.firstVisible, pages - 1);
      let next = -1;
      for (let i = from; i < Math.min(pages, from + 3); i++) if (!gen.done.has(i)) { next = i; break; }
      if (next < 0) for (let i = 0; i < pages; i++) if (!gen.done.has(i)) { next = i; break; }
      if (next < 0) break;
      await this.render(file, next + 1, `${appHome()}/${rel}/p${next + 1}.png`);
      if (seq !== this.seq) return;
      gen.done.add(next);
      cx.notify();
    }
    // Every page of the new build is drawn: the previous one can go.
    if (this.prev) {
      exec("rm", ["-rf", `${appHome()}/${this.prev.rel}`]).catch(() => null);
      this.prev = null;
      cx.notify();
    }
  }

  async render(file, n, out) {
    const args = ["-png", "-singlefile", "-f", `${n}`, "-l", `${n}`, "-scale-to-x", `${PAGE_PX}`, "-scale-to-y", "-1"];
    if (!this.on) {
      await exec("pdftoppm", [...args, file, out.replace(/\.png$/, "")]).catch(() => null);
      return;
    }
    const r = await exec("sh", ["-c", `pdftoppm ${args.join(" ")} "$1" | base64 -w0`, "herdr-latex", file], { on: this.on }).catch(() => null);
    if (r?.code === 0 && r.stdout) await fs.writeFile(out, Buffer.from(r.stdout.trim(), "base64"));
  }

  pages() {
    return this.gen?.pages ?? 0;
  }

  go(i) {
    if (!this.gen) return;
    this.page = Math.max(0, Math.min(this.gen.pages - 1, i));
    this.scroll.scroll_to_item(this.page);
  }

  view(width, t) {
    const gen = this.gen;
    const W = Math.max(120, width - 36);
    const H = Math.round(W * gen.aspect);
    return div().relative().flex_1().min_h(0).w_full()
      .child(v_virtual_list("herdr-latex-pdf", gen.pages, H + 12, (i) => `p${i}`, (range) => {
        this.firstVisible = range.start;
        const out = [];
        for (let i = range.start; i < range.end; i++) {
          const src = gen.done.has(i) ? `${gen.rel}/p${i + 1}.png`
            : this.prev && this.prev.done.has(i) && i < this.prev.pages ? `${this.prev.rel}/p${i + 1}.png` : null;
          out.push(h_flex().id(`page-${i}`).w_full().h(H + 12).flex_none().justify_center().pt(12)
            .child(src
              ? div().w(W).h(H).bg("#ffffff").child(image(src).size_full())
              : div().w(W).h(H).bg(t.surface).flex().items_center().justify_center().text_color(t.dim).text_size(12).child(`Page ${i + 1}…`)));
        }
        return out;
      }).track_scroll(this.scroll).size_full())
      .child(Scrollbar.vertical("herdr-latex-pdf").absolute().inset_0());
  }
}
