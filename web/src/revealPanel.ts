/**
 * Bring a just-opened dropdown fully into view.
 *
 * The filter controls expand inline rather than floating, so they work in the
 * narrow desktop column and the mobile bottom sheet without clipping. The cost
 * is that opening one near the bottom of the sheet renders it below the fold:
 * the date picker in particular is a calendar, and tapping "Received" put most
 * of it off the bottom of the screen with no sign that anything had happened.
 *
 * Two steps, in order. First the panel is capped to the height actually
 * available, so a tall one scrolls inside itself rather than demanding room
 * that isn't there. Then the sheet is scrolled by the smallest amount that
 * brings the whole panel into view — never further, so the control you just
 * tapped stays where your finger left it.
 */

/** The nearest ancestor that actually scrolls, or null if nothing does. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if ((overflowY === "auto" || overflowY === "scroll") && p.scrollHeight > p.clientHeight) {
      return p;
    }
  }
  return null;
}

/** Breathing room kept between the panel and the edge of the scroll area. */
const MARGIN = 12;

export function revealPanel(panel: HTMLElement | null): void {
  if (!panel) return;
  const scroller = scrollParent(panel);
  if (!scroller) return;

  const view = scroller.getBoundingClientRect();
  const available = view.height - 2 * MARGIN;

  // Cap first: the measurement that decides how far to scroll has to be taken
  // after the panel has settled at the height it will keep.
  const natural = panel.scrollHeight;
  if (natural > available) {
    panel.style.maxHeight = `${Math.max(160, available)}px`;
    panel.style.overflowY = "auto";
  }

  const box = panel.getBoundingClientRect();
  let delta = 0;
  if (box.bottom > view.bottom - MARGIN) {
    delta = box.bottom - (view.bottom - MARGIN);
    // Never push the top of the panel out of sight to reveal its bottom.
    delta = Math.min(delta, box.top - (view.top + MARGIN));
  } else if (box.top < view.top + MARGIN) {
    delta = box.top - (view.top + MARGIN);
  }
  if (delta !== 0) scroller.scrollBy({ top: delta, behavior: "smooth" });
}

/** Undo the cap, so the panel measures naturally the next time it opens. */
export function releasePanel(panel: HTMLElement | null): void {
  if (!panel) return;
  panel.style.maxHeight = "";
  panel.style.overflowY = "";
}
