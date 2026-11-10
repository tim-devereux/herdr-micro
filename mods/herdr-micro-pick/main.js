// herdr-micro-pick (cmd-shift-o): opens herdr-micro's file picker for the
// focused tab as a dialog, then closes itself. (A mod can't import another
// mod's files, and `mod.open` passes no props, hence this launcher.)

import { View, div } from "gpui-kit";
import { closeOverlay, focused, openOverlay, props } from "herdr";

export default class HerdrMicroPick extends View {
  init() {
    const f = focused();
    const overlay = props()?.overlay;
    if (overlay) {
      openOverlay({ mod: "herdr-micro", kind: "dialog", width: 760, height: 460,
        props: { role: "pick", place: f ? { space: f.space, tab: f.tab, terminal: f.terminal, cwd: f.cwd } : null } });
      closeOverlay(overlay);
    }
  }

  render() {
    return div();
  }
}
