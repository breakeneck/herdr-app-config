// Obsolete: generation settings now live inline in the Changes panel (Generate ▾ → Settings).
// This stub keeps any old open copy of the dialog from crashing; it renders invisibly
// and tries to close itself on reload.

import { View, div } from "gpui-kit";
import { props, closeOverlay } from "herdr";

export default class CommitSettings extends View {
  init(_props, cx) {
    const id = props()?.overlay;
    if (id) cx.spawn(async () => { closeOverlay(id); });
  }

  render() {
    return div().id("cs-gone").size(0).overflow_hidden();
  }
}