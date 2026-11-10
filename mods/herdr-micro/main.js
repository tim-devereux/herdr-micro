// herdr-micro: micro beside your agents, with a file tree.
//
// One mod, three roles, chosen by its props:
// - an overlay (`mod.open:herdr-micro`, ctrl-alt-m): toggles the focused tab's
//   micro pane and the tree beside it, then closes itself;
// - a pane with props {role: "tree", tab, root}: the file tree (tree.js);
// - a dialog with props {role: "pick", place}: the file picker (pick.js),
//   opened by the herdr-micro-pick mod (cmd-shift-o).

import { View, div } from "gpui-kit";
import { closeOverlay, focused, notify, props } from "herdr";
import { closePair, openPair, pairShown, sweep } from "./micro.js";
import { Pick } from "./pick.js";
import { Tree } from "./tree.js";

export default class HerdrMicro extends View {
  init(_props, cx) {
    const { overlay, role } = props() ?? {};
    if (role === "tree") this.part = new Tree(cx);
    else if (role === "pick") this.part = new Pick(cx);
    else if (overlay) {
      const f = focused();
      cx.spawn(async (cx) => {
        try {
          if (!f?.tab) notify({ title: "herdr-micro", body: "Open a tab first.", level: "warning" });
          else if (pairShown(f.tab)) closePair(f.tab);
          else await openPair(cx, f);
          await sweep();
        } finally {
          closeOverlay(overlay);
        }
      });
    }
  }

  async close() {
    this.part?.close?.();
  }

  render(cx) {
    return this.part ? this.part.render(cx) : div();
  }
}
