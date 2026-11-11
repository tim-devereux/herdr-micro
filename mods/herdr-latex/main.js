// herdr-latex: LaTeX beside micro. ctrl-alt-l (`mod.open:herdr-latex`)
// toggles the tab's LaTeX pane right of its micro (herdr-micro): latexmk
// rebuilds on every save, and the pane shows the PDF, problems, outline and
// word count (pane.js). Closing the pane stops latexmk.
//
// One mod, two roles: an overlay (the toggle, which closes itself) and a
// pane with props {tab}.

import { View, div } from "gpui-kit";
import { closeOverlay, focused, notify, panes, props, run } from "herdr";
import { LatexPane } from "./pane.js";
import { latexPane, MOD, microOf, shownPane, waitFor } from "./util.js";

export default class HerdrLatex extends View {
  init(_props, cx) {
    const { overlay, tab } = props() ?? {};
    if (tab) this.part = new LatexPane(cx);
    else if (overlay) {
      const f = focused();
      cx.spawn(async (cx) => {
        try {
          if (!f?.tab) return notify({ title: "herdr-latex", body: "Open a tab first.", level: "warning" });
          await toggle(cx, f);
        } finally {
          closeOverlay(overlay);
        }
      });
    }
  }

  async close(cx) {
    await this.part?.close?.(cx);
  }

  render(cx) {
    return this.part ? this.part.render(cx) : div();
  }
}

async function toggle(cx, f) {
  const tab = f.tab;
  const open = latexPane(tab);
  if (open) return run("pane.close", { pane: open.pane });
  // Beside micro: herdr-micro's pane, opened first when the tab has none.
  const inTab = (mod) => panes().find((p) => p.mod === mod && p.tab === tab);
  let m = microOf(tab);
  if (!(m && shownPane(m.address)) && !inTab("herdr-micro") && !inTab("herdr-micro-view")) {
    run("mod.open", { name: "herdr-micro" });
    // micro, then its tree: split only once both are in, so the pane always
    // lands between them (micro | LaTeX | tree).
    await waitFor(cx, () => { m = microOf(tab); return m && shownPane(m.address) && inTab("herdr-micro"); }, 8000);
  }
  const anchor = (m && shownPane(m.address)) ?? inTab("herdr-micro-view") ?? panes().find((p) => p.pane === f.pane);
  run("pane.split", { direction: "right", ...(anchor ? { pane: anchor.pane } : {}), mod: MOD, props: { tab } });
  await waitFor(cx, () => latexPane(tab));
}
