/**
 * Controller glyph hints (components/ButtonHints.tsx): the logical button of a hint and the physical one
 * the user has to press under the current A/B layout. Kept out of the component file so React fast-refresh
 * keeps working and the swap can be unit tested.
 */
/** 'dpad' = the D-pad's up / down pair, 'rs' = the right stick. */
export type HintButton =
  'a' | 'b' | 'x' | 'y' | 'lb' | 'rb' | 'lt' | 'rt' | 'start' | 'select' | 'dpad' | 'rs'

/**
 * The physical button for a logical hint button. Hints name the standard-layout button ('a' = accept,
 * 'b' = back); with settings.input.swapAB on (Nintendo layout, see input/gamepad.ts) A and B trade places.
 */
export function displayButton(button: HintButton, swapAB: boolean): HintButton {
  if (!swapAB) return button
  if (button === 'a') return 'b'
  if (button === 'b') return 'a'
  return button
}
