// Sideways swipes, on a phone and nowhere else.
//
// Two gestures share the same finger and the same direction, so they share the
// rules that keep them apart: a swipe that STARTS at the left edge of the screen
// pulls the list of mailboxes in (NavRail), and one that starts anywhere else on
// a row slides that row open to show what can be done to it (SwipeRow). Written
// down once here rather than as two numbers that happen to agree today.
//
// "A phone" is the width core folds its own sidebar at, which is also where the
// inbox frame goes edge to edge (see inbox.css). A mouse never swipes, and a
// tablet held wide has the room to show every button there is, so nothing
// below is ever switched on above this width.

/** The width a phone is, as a media query. Matches the stylesheet's own. */
export const PHONE_QUERY = '(max-width: 768px)'

/** How far in from the left edge a touch still counts as "from the edge". Wide
 *  enough to hit with a thumb, narrow enough that a row's own swipe is not
 *  eaten by it. */
export const EDGE_PX = 24

/** How far a finger has to travel before the gesture decides whether it is a
 *  swipe or a scroll. Below this it is neither, and a tap is still a tap. */
export const DECIDE_PX = 8

/** How far a sideways swipe has to go before letting go keeps it. */
export const COMMIT_PX = 56

export function isPhone(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(PHONE_QUERY).matches
}
