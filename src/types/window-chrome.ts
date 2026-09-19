/**
 * Where the macOS traffic lights sit, in CSS px from the window's top-left.
 *
 * `trafficLightPosition` is handed to Electron as-is, and Electron treats it as
 * the margin of the button group — the corner of the close button's *frame*
 * (`WindowButtonsProxy::setMargin`), not of the 12px circle drawn inside it.
 * macOS 11+ frames are 14 wide with 20px between origins, so the group ends
 * `BUTTON_SPACING * 2 + BUTTON_FRAME_WIDTH` right of that corner.
 *
 * The sidebar's wordmark centres in the space the dots leave, so both numbers
 * are derived here rather than copied into the CSS: half a pixel of drift
 * between the two is visible against a 15px wordmark.
 *
 * The vertical centre is *measured*, not computed. Three circles in a 2x window
 * screenshot agreed on y = 25.5 to within 0.03px; the frame maths above would
 * put it at 26, so the circle does not sit exactly centred in its frame.
 */
export const TRAFFIC_LIGHT_POSITION = { x: 20, y: 18 } as const

const BUTTON_SPACING = 20
const BUTTON_FRAME_WIDTH = 14

/** Vertical centre of the three circles — the line the wordmark sits on. */
export const TRAFFIC_LIGHT_CENTER_Y = 25.5

/**
 * The height a titlebar strip must be for `items-center` to land its content on
 * that line.
 *
 * A strip here is a `flex items-center` row with a bottom border, and the border
 * is inside the box (`box-sizing: border-box`), so the content box is one pixel
 * shorter than the strip: `(H - 1) / 2 === TRAFFIC_LIGHT_CENTER_Y` gives
 * `H = 2 * 25.5 + 1 = 52`. Measured before this constant existed: the reader's
 * header (`h-11`, 44px) put its four controls **4px above** the lights, and the
 * library's toolbar (`h-14`, 56px) put its search, sort and view controls
 * **2px below** them — each strip centring on its own middle, which is not the
 * line the eye reads against the dots.
 *
 * The sidebar's drag strip is deliberately not one of these: it has no bottom
 * border and positions the wordmark *on* the line (`top: TRAFFIC_LIGHT_CENTER_Y`)
 * rather than centring a row inside itself, so its own height is free.
 */
export const TITLEBAR_STRIP_HEIGHT = TRAFFIC_LIGHT_CENTER_Y * 2 + 1

/** Right edge of the buttons: where the dots end and the free space starts. */
export const TRAFFIC_LIGHT_RIGHT_EDGE =
  TRAFFIC_LIGHT_POSITION.x + BUTTON_SPACING * 2 + BUTTON_FRAME_WIDTH
