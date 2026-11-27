# Input and focus

Decision (docs/ARCHITECTURE.md §1): the renderer uses `@noriginmedia/norigin-spatial-navigation` 3.4 as its
one focus engine. It handles the geometric focus tree (rows are containers that remember their last focused
child, modals are focus boundaries) and we drive it ourselves; the custom-engine fallback was not needed.

How the pieces fit:

- `focus.ts` initialises Norigin once (`shouldFocusDOMNode: false`) and re-exports its API. Norigin's own
  keyboard bindings are pointed at a key code that never occurs, so **every** input goes through
  `dispatchAction` (one path for gamepad, keyboard and pointer). `pressEnter` / `pressArrow` call the focused
  element's `onEnterPress` / `onArrowPress` directly through the `SpatialNavigation` singleton (verified API).
- `actions.ts` is the action bus: directions -> `pressArrow` then `navigateByDirection`; `accept` ->
  `pressEnter`; other buttons -> the handlers of the top **layer**. `useFocusLayer` (every `Modal`) pushes a
  layer on mount and pops it on unmount, so only the topmost modal receives back/x/y/... presses.
- `gamepad.ts` polls `navigator.getGamepads()` per animation frame (standard mapping, edge detection,
  direction repeat from `settings.input`, swap A/B, `rumble()`).
- `keyboard.ts` maps keys (see `actionForKey`); keys inside text fields belong to the field, Escape blurs it.
- `pointer.ts` sets the input method from `pointerType`, maps the mouse back button to B and hides the cursor
  while a gamepad is in use.

Components focus by hover (mouse, 60 ms dwell on cards) and activate on click/tap through
`hooks/useFocusableControl.ts`; `<html data-input-method>` decides whether the accent focus ring is drawn.
