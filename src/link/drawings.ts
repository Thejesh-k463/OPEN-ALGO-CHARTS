/**
 * The drawings channel of a link group, split across two tiers on purpose.
 *
 * The group, here in the base tier, decides **who** shares drawings with whom:
 * the members of one group, while its `drawings` switch is on. The draw tier's
 * `DrawingLinkGroup` decides **which** drawings cross and moves them. Keeping
 * the second half out of this file is what keeps drawing code out of the base
 * bundle, and keeping the first half here is what lets one group, and one
 * saved set of switches, carry every channel a grid links on.
 *
 * The rule a host can rely on, whichever sharer sits behind the adapter:
 *
 * - **Only between charts showing the same instrument**, symbol and exchange.
 *   A level drawn on one stock means nothing on another, so a chart on another
 *   instrument neither sends nor receives, whatever its group.
 * - **Only price-pane drawings in data space.** A drawing pinned to the
 *   viewport is a place on this chart's screen and stays on it.
 * - **Drawn while the channel is on, to the charts present.** A drawing
 *   crosses to the charts on its instrument when it is drawn, and its edits
 *   and its deletion follow it there. Drawings already on a chart stay private
 *   to it until the host shares them (`DrawingLinkGroup.share`), so switching
 *   the channel on never sprays one chart's levels across a desk; a chart that
 *   arrives on the instrument later gets a drawing shared without it the same
 *   way, when the host shares it again.
 * - **An instrument change keeps drawings with their instrument.** Drawings are
 *   kept per instrument (`InstrumentDrawings`), so a chart leaving an instrument
 *   takes its copies of the shared drawings into that instrument's saved
 *   document and shows the incoming instrument's own. When it comes back they
 *   reconnect, and take the state the charts still on it hold now, a deletion
 *   included. With symbol linking on, the whole group moves together and keeps
 *   sharing on the new instrument.
 * - **Leaving keeps what arrived.** Switching the channel off, or taking a chart
 *   out of the group, stops the traffic; every copy already made stays where it
 *   is, now private to that chart.
 */

/**
 * One member's side of drawing sharing, supplied by the host. Usually two
 * lines over a draw-tier `DrawingLinkGroup` kept for the group:
 *
 * ```ts
 * group.add(chart, { drawings: {
 *   join: () => sharing.add(chart, controller),
 *   leave: () => sharing.remove(chart),
 * } });
 * ```
 *
 * The group calls `join` when the member is in it and the channel is on, and
 * `leave` when either stops being true (the switch goes off, the member is
 * removed, replaces its adapter or is destroyed, or the group is destroyed).
 * Calls alternate: never two joins without a leave between them.
 */
export interface LinkDrawingsAdapter {
  /** Start sharing this chart's drawings with the rest of the group. */
  join(): void;
  /** Stop sharing. Copies already made stay on every chart that holds one. */
  leave(): void;
}
