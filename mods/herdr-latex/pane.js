// The LaTeX pane, right of the tab's micro: `latexmk -pvc` runs on the
// tab's machine in a hidden core terminal (it rebuilds on every save), and
// this pane shows the PDF, the problems from the log, the outline and the
// word count. Clicking a problem or a heading moves micro there.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, exec, hc, nextCommand, notify, props, readTextFile, run, setShared, shared, theme } from "herdr";
import { PdfView } from "./pdf.js";
import { outline, parseLog } from "./parse.js";
import { basename, dirname, latexmkOf, LATEXMK, machineOf, microAt, microOf, onScreen, shownPane, tabRoot } from "./util.js";

const MAIN = "herdr-latex.main"; // shared: {[tab]: main .tex}
const FIND_MAINS = `find "$1" -maxdepth 3 -name '*.tex' -not -path '*/.*' -print0 |
  xargs -0 -r grep -lE '^[[:space:]]*\\\\documentclass' 2>/dev/null | sort`;

export class LatexPane {
  constructor(cx) {
    this.tab = props().tab;
    this.on = machineOf(this.tab);
    this.handle = cx.focus_handle();
    this.pdf = new PdfView(this.tab, this.on);
    this.problems = [];
    this.outline = [];
    this.words = null;
    this.panel = true;
    this.panelTab = "problems";
    this.showBoxes = false;
    this.status = "starting"; // starting | building | idle | stopped | missing | none
    this.message = "Looking for a main .tex file…";
    this.mains = [];
    this.handle.focus();
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") { this.handle.focus(); cx.notify(); }
      }
    });
    cx.spawn(async (cx) => this.setup(cx));
    cx.spawn(async (cx) => {
      while (!this.closed) {
        await cx.sleep(onScreen(this.tab) ? 1200 : 3000);
        if (this.closed) return;
        await this.poll(cx).catch(() => null);
      }
    });
  }

  async close() {
    this.closed = true;
    this.pdf.closed = true;
    const t = latexmkOf(this.tab);
    await Promise.all([
      t ? exec("hc", ["kill", t.address]).catch(() => null) : null,
      this.pdf.close(),
    ]);
  }

  rel(path) {
    return this.root && path?.startsWith(`${this.root}/`) ? path.slice(this.root.length + 1) : path;
  }

  async setup(cx) {
    this.root = await tabRoot(this.tab, this.on);
    const r = await exec("sh", ["-c", FIND_MAINS, "herdr-latex", this.root], { on: this.on }).catch(() => null);
    this.mains = (r?.stdout ?? "").split("\n").filter(Boolean);
    const saved = shared(MAIN)?.[this.tab];
    const running = latexmkOf(this.tab)?.labels?.["herdr-latex.main"];
    const main = [running, saved].find((m) => m && this.mains.includes(m))
      ?? (this.mains.length === 1 ? this.mains[0] : this.mains.find((m) => /\/(main|thesis|paper|report)\.tex$/.test(m)));
    if (!this.mains.length) {
      this.status = "none";
      this.message = `No .tex file with \\documentclass in ${this.root}`;
    } else if (!main) {
      this.choosing = true;
    } else {
      await this.start(cx, main);
    }
    cx.notify();
  }

  // latexmk -pvc for `main`, unless one already runs for it.
  async start(cx, main) {
    this.choosing = false;
    this.main = main;
    this.pdfPath = main.replace(/\.tex$/, ".pdf");
    this.logPath = main.replace(/\.tex$/, ".log");
    this.logMtime = this.pdfMtime = this.pdfShown = null;
    this.problems = [];
    this.outline = [];
    this.words = null;
    const all = shared(MAIN) ?? {};
    setShared(MAIN, { ...all, [this.tab]: main });
    const t = latexmkOf(this.tab);
    if (t && t.labels?.["herdr-latex.main"] === main) {
      this.address = t.address;
      this.status = "building";
    } else {
      if (t) await hc(["kill", t.address]).catch(() => null);
      const has = await exec("sh", ["-c", "command -v latexmk"], { on: this.on }).catch(() => null);
      if (has?.code !== 0) {
        this.status = "missing";
        this.message = `latexmk isn't installed on ${this.on ?? "this computer"}.`;
        return cx.notify();
      }
      const r = await hc(["run", "--bg", "--json", ...(this.on ? ["--on", this.on] : []), "--cwd", dirname(main),
        "--label", `${LATEXMK}=${this.tab}`, "--label", `herdr-latex.main=${main}`, "--",
        "latexmk", "-pdf", "-pvc", "-view=none", "-interaction=nonstopmode", "-file-line-error", "-synctex=1", basename(main)])
        .catch((e) => ({ stdout: "", stderr: String(e) }));
      try { this.address = JSON.parse(r.stdout).address; } catch { this.address = null; }
      if (!this.address) {
        this.status = "stopped";
        this.message = `latexmk did not start: ${(r.stderr || r.stdout).trim().slice(-200)}`;
        return cx.notify();
      }
      this.status = "building";
    }
    cx.notify();
    await this.poll(cx);
  }

  async poll(cx) {
    if (!this.main || !this.address || this.status === "missing") return;
    const t = latexmkOf(this.tab);
    const before = `${this.status}|${this.logMtime}|${this.pdfMtime}`;
    if (!t) {
      this.status = "stopped";
      this.message = "latexmk stopped.";
    } else {
      const screen = (await hc(["read", this.address, "--lines", "40"]).catch(() => null))?.stdout ?? "";
      // What latexmk prints while it builds, then "Watching" once it waits.
      const run = Math.max(...["Running '", "Reasons for rerun", "Run number", "applying rule"].map((s) => screen.lastIndexOf(s)));
      const idle = screen.lastIndexOf("Watching for updated files");
      this.status = run > idle ? "building" : idle >= 0 ? "idle" : "building";
    }
    const st = await exec("stat", ["-L", "-c", "%Y %n", this.pdfPath, this.logPath], { on: this.on }).catch(() => null);
    const mtimes = {};
    for (const line of (st?.stdout ?? "").split("\n")) {
      const sp = line.indexOf(" ");
      if (sp > 0) mtimes[line.slice(sp + 1)] = line.slice(0, sp);
    }
    const logM = mtimes[this.logPath] ?? null, pdfM = mtimes[this.pdfPath] ?? null;
    if (logM && logM !== this.logMtime && this.status !== "building") {
      this.logMtime = logM;
      const log = await readTextFile(this.logPath, { on: this.on }).catch(() => null);
      if (log != null) this.problems = parseLog(log, this.main);
      this.outline = await outline(this.main, this.on).catch(() => this.outline);
    }
    this.pdfMtime = pdfM;
    if (pdfM && pdfM !== this.pdfShown && onScreen(this.tab)) {
      this.pdfShown = pdfM;
      cx.spawn(async (cx) => this.pdf.load(cx, this.pdfPath, pdfM));
      const wc = await exec("sh", ["-c", 'pdftotext -q "$1" - | wc -w', "herdr-latex", this.pdfPath], { on: this.on }).catch(() => null);
      this.words = wc?.code === 0 ? Number(wc.stdout.trim()) : null;
    }
    if (before !== `${this.status}|${this.logMtime}|${this.pdfMtime}`) cx.notify();
  }

  rebuild(cx) {
    if (this.status === "stopped" && this.main) return cx.spawn(async (cx) => this.start(cx, this.main));
    // latexmk -pvc rebuilds when a source changes.
    if (this.main) exec("touch", [this.main], { on: this.on }).catch(() => null);
    this.status = "building";
    cx.notify();
  }

  // micro to a file and line (a problem, a heading).
  jump(file, line, cx) {
    const m = microOf(this.tab);
    if (!m || !shownPane(m.address)) {
      notify({ title: "herdr-latex", body: "Open micro first (ctrl-alt-m).", level: "warning" });
      return;
    }
    cx.spawn(async (cx) => {
      await microAt(cx, m.address, file, line);
      run("pane.focus", { terminal: m.address });
    });
  }

  // The build's errors (and undefined references) to the tab's agent.
  fixWithAgent(cx) {
    const agent = agents().find((a) => a.tab === this.tab && a.focused) ?? agents().find((a) => a.tab === this.tab);
    if (!agent) {
      notify({ title: "herdr-latex", body: "No agent in this tab to send the errors to.", level: "warning" });
      return;
    }
    const list = this.problems.filter((p) => p.kind === "error" || /undefined/i.test(p.msg));
    const lines = list.slice(0, 40).map((p) => `- ${this.rel(p.file)}${p.line ? `:${p.line}` : ""}: ${p.msg}`);
    const text = `The LaTeX build of ${this.rel(this.main)} (latexmk, see ${this.rel(this.logPath)}) has these problems. Please fix them:\n${lines.join("\n")}`;
    cx.spawn(async () => {
      const r = await hc(["send", agent.address, text]).catch((e) => ({ code: 1, stderr: String(e) }));
      notify(r.code === 0
        ? { title: "herdr-latex", body: `Sent ${list.length} problem${list.length === 1 ? "" : "s"} to ${agent.program?.name ?? "the agent"}.`, level: "success" }
        : { title: "herdr-latex: not sent", body: (r.stderr || "").trim().slice(-200), level: "error" });
    });
  }

  key(e, cx) {
    const plain = !e.modifiers.control && !e.modifiers.alt && !e.modifiers.platform;
    const k = plain && e.key_char && e.key_char.trim() ? e.key_char : e.keystroke;
    switch (k) {
      case "j": case "n": case "down": case "space": case "pagedown": this.pdf.go(this.pdf.page + 1); break;
      case "k": case "p": case "up": case "pageup": this.pdf.go(this.pdf.page - 1); break;
      case "g": case "home": this.pdf.go(0); break;
      case "G": case "end": this.pdf.go(Infinity); break;
      case "e": this.panel = !this.panel; break;
      case "r": this.rebuild(cx); break;
      case "m": if (this.mains.length > 1) this.choosing = !this.choosing; break;
      default: return;
    }
    cx.stop_propagation();
    cx.notify();
  }

  button(id, label, t, onClick, accent = false) {
    return div().id(id).flex_none().px(8).h(22).flex().items_center().rounded(11).border_1()
      .border_color(accent ? t.accent : t.border).text_color(accent ? t.accent : t.foreground)
      .text_size(11.5).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => onClick(cx))
      .child(label);
  }

  chip(t) {
    const errors = this.problems.filter((p) => p.kind === "error").length;
    const warnings = this.problems.filter((p) => p.kind === "warning").length;
    if (this.status === "building" || this.status === "starting") {
      return h_flex().flex_none().gap(5).items_center().text_size(11.5).text_color(t.working)
        .child(svg("mods/workspace-chrome/spinner.svg").size(11).spin(900).text_color(t.working)).child("Building");
    }
    if (this.status === "stopped" || this.status === "missing") return div().flex_none().text_size(11.5).text_color(t.ansi1).child(this.status === "missing" ? "No latexmk" : "Stopped");
    if (errors) return div().flex_none().text_size(11.5).text_color(t.ansi1).child(`${errors} error${errors === 1 ? "" : "s"}`);
    if (warnings) return div().flex_none().text_size(11.5).text_color(t.blocked).child(`Built · ${warnings} warning${warnings === 1 ? "" : "s"}`);
    return div().flex_none().text_size(11.5).text_color(t.ansi2).child(this.logMtime ? "Built" : "");
  }

  chooser(t) {
    return v_flex().flex_1().min_h(0).p(12).gap(4).overflow_y_scrollbar()
      .child(div().text_size(12).text_color(t.dim).pb(6).child("Which file is the main document?"))
      .children(this.mains.map((m, i) => h_flex().id(`main-${i}`).h(26).px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .when(m === this.main, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => cx.spawn(async (cx) => this.start(cx, m)))
        .child(svg("mods/files/file.svg").size(14).text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(this.rel(m)))));
  }

  problemRow(p, i, t) {
    const color = p.kind === "error" ? t.ansi1 : p.kind === "warning" ? t.blocked : t.dim;
    return h_flex().id(`prob-${i}`).h(24).flex_none().px(8).gap(8).items_center().rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.jump(p.file, p.line, cx))
      .child(div().w(12).flex_none().text_color(color).child(p.kind === "error" ? "✕" : p.kind === "warning" ? "!" : "·"))
      .child(div().flex_1().min_w(0).truncate().text_color(p.kind === "box" ? t.muted : t.foreground).child(p.msg))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(`${basename(p.file)}${p.line ? `:${p.line}` : ""}`));
  }

  panelView(t) {
    const boxes = this.problems.filter((p) => p.kind === "box").length;
    const shown = this.problems.filter((p) => this.showBoxes || p.kind !== "box");
    const minLevel = Math.min(...this.outline.map((o) => o.level), 9);
    const tabBtn = (id, label, on) => div().id(id).flex_none().px(8).h(26).flex().items_center().cursor_pointer()
      .border_b(2).border_color(on ? t.accent : "#00000000").text_color(on ? t.foreground : t.muted)
      .on_click((_e, cx) => { this.panelTab = id; cx.notify(); }).child(label);
    const body = this.panelTab === "problems"
      ? (shown.length
        ? shown.map((p, i) => this.problemRow(p, i, t))
        : [div().p(10).text_color(t.dim).child(this.logMtime ? "No problems." : "No build yet.")])
      : (this.outline.length
        ? this.outline.map((o, i) => h_flex().id(`out-${i}`).h(24).flex_none().pl(8 + (o.level - minLevel) * 14).pr(8).gap(8).items_center().rounded(5).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.jump(o.file, o.line, cx))
          .child(div().flex_1().min_w(0).truncate().text_color(o.level - minLevel === 0 ? t.foreground : t.muted).child(o.title))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(`${basename(o.file)}:${o.line}`)))
        : [div().p(10).text_color(t.dim).child("No sections.")]);
    return v_flex().h(220).flex_none().border_t(1).border_color(t.border).bg(t.background)
      .child(h_flex().h(28).flex_none().px(6).gap(2).items_end().border_b(1).border_color(t.border)
        .child(tabBtn("problems", `Problems ${this.problems.length - boxes || ""}`.trim(), this.panelTab === "problems"))
        .child(tabBtn("outline", "Outline", this.panelTab === "outline"))
        .child(div().flex_1())
        .when(this.panelTab === "problems" && boxes > 0, (el) => el.child(div().id("boxes").flex_none().px(6).h(26).flex().items_center()
          .text_size(11).text_color(this.showBoxes ? t.accent : t.dim).cursor_pointer()
          .on_click((_e, cx) => { this.showBoxes = !this.showBoxes; cx.notify(); })
          .child(`${boxes} bad box${boxes === 1 ? "" : "es"}`)))
        .child(div().flex_none().px(8).h(26).flex().items_center().text_size(11).text_color(t.dim)
          .child(this.words != null ? `${this.words.toLocaleString()} words` : "")))
      .child(v_flex().id("panel-list").flex_1().min_h(0).p(4).overflow_y_scrollbar().children(body));
  }

  render() {
    const t = theme();
    const focusedNow = this.handle.is_focused();
    const fixable = this.problems.some((p) => p.kind === "error" || /undefined/i.test(p.msg));
    const body = this.choosing
      ? this.chooser(t)
      : this.pdf.pages()
        ? this.pdf.view(this.size?.width ?? 700, t)
        : div().flex_1().p(20).text_color(t.dim).child(
          this.status === "building" ? "Building the PDF…" : this.status === "idle" ? "No PDF yet: see Problems." : this.message);
    return v_flex().id("root").size_full().min_h(0).bg(t.canvas ?? t.background).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", () => this.handle.focus())
      .child(h_flex().h(34).flex_none().px(12).gap(8).items_center().bg(t.background).border_b(1).border_color(focusedNow ? t.accent : t.border)
        .child(div().flex_none().font_semibold().child("LaTeX"))
        .child(div().id("main-name").flex_1().min_w(0).truncate().text_color(t.dim)
          .when(this.mains.length > 1, (el) => el.cursor_pointer().on_click((_e, cx) => { this.choosing = !this.choosing; cx.notify(); }))
          .child(this.main ? this.rel(this.main) : ""))
        .child(this.chip(t))
        .when(this.pdf.pages() > 0, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child(`${this.pdf.pages()} p`)))
        .when(fixable, (el) => el.child(this.button("fix", "Fix with agent", t, (cx) => this.fixWithAgent(cx), true)))
        .when(Boolean(this.main), (el) => el.child(this.button("build", this.status === "stopped" ? "Restart" : "Build", t, (cx) => this.rebuild(cx))))
        .child(this.button("panel", this.panel ? "Hide panel" : "Panel", t, (cx) => { this.panel = !this.panel; cx.notify(); })))
      .child(body)
      .when(this.panel && !this.choosing, (el) => el.child(this.panelView(t)))
      .child(div().flex_none().px(10).py(4).border_t(1).border_color(t.border).bg(t.background).text_size(10.5).text_color(t.dim).truncate()
        .child("j/k page · e panel · r rebuild · m main file · click a problem or heading to jump micro there"));
  }
}
