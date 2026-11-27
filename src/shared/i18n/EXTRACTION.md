# Moving text into the language files

For anyone (agents included) moving PlayOut's user-facing text out of the code. Translators read
`docs/TRANSLATING.md`; this is the code side. The worked example is
`src/renderer/src/screens/Settings/sections/System.tsx` with `locales/{en,es}/settingsSystem.json`.

## Where strings go

- `src/shared/i18n/locales/en/<namespace>.json`: the English text, nested JSON of strings. **One namespace per
  area** (camelCase file name), so parallel work never edits the same file: `settingsSystem`, `settingsLibrary`,
  `home`, `gameDetail`, `overlay`, `addGames`, `tray`, `notices`, `common` (only truly shared words: OK, Cancel,
  Back...). Make a new file for a new area; it is picked up automatically (import.meta.glob), no registration.
- `src/shared/i18n/locales/es/<namespace>.json`: the Spanish machine translation, **same keys, same nesting**.
  Translate every string you add to `en`, keeping `{variables}` and brand names as they are.
- Key = `<namespace>.<path>`: `t('settingsSystem.power.helper.install')`. Group by screen part
  (`power.helper.install`), name by meaning, not by wording (`exit.confirmToTray`, not `closeTheDashboardTo...`).
  A row's text is `<thing>.label` + `<thing>.description`.

## Using them

| Where                                 | Import                                                           | Use                                   |
| ------------------------------------- | ---------------------------------------------------------------- | ------------------------------------- |
| React component (renderer)            | `import { useT } from '<relative>/i18n'` (src/renderer/src/i18n) | `const t = useT()` then `t('ns.key')` |
| Store, lib, event handler (renderer)  | `import { t } from '<relative>/i18n'`                            | `t('ns.key', { name })` at call time  |
| Main process                          | `import { tMain } from '<relative>/i18n'` (src/main/i18n)        | `tMain('ns.key', { name })`           |
| Main text built once (tray menu, ...) | `onMainLanguageChange(rebuild)` from src/main/i18n               | rebuild it when the language changes  |

- In components always use `useT()` (it re-renders on a language change); add `t` to `useCallback`/`useMemo`
  dependency lists that use it.
- **Never keep translated text in a module-level constant**: `const LABELS = { a: t('x') }` freezes the language
  of the moment the module loaded. Turn such tables into functions that take `t` (see `windowsPages(t)` in
  System.tsx), or keep the keys and call `t()` at render time.
- Plain helpers that return text (`fooText(status)`) take a `t: Translate` parameter (type from the same i18n
  module) or call the renderer's `t()` inside; update their tests to compare with `t('...')`, or keep expecting
  English (tests run in English).
- Write keys as **string literals** inside `t('...')` / `tMain('...')`: the test
  `src/shared/i18n/locales.test.ts` scans for them and fails on a key English lacks. Avoid building keys from
  variables (``t(`ns.${id}`)``): the scan cannot see them. When unavoidable, make sure every possible key is in
  English and say so in a comment.
- Main-process text the renderer shows (notices, toasts, errors meant for the user) is translated in main with
  `tMain` at the moment it is sent.

## What to translate

Yes: labels, titles, descriptions, button text, menu and select options, placeholders, `aria-label` / `title`
attributes, toasts, notices, modal titles and messages, empty states, status lines, hints and help paragraphs,
tray menu items, dialog text from main.

No: game, store, emulator and brand names (PlayOut, Steam, Xbox, RetroArch...), file names and paths, ids,
setting keys, enum values sent to main, log messages (`log.error(...)`), developer errors (thrown `Error`s nobody
reads in the UI), CSS class names, URLs, test fixtures, keyboard key names in code. Text that comes from a game's
metadata is never translated.

## Text built from parts

Translate **whole sentences** with variables, never fragments glued together; word order differs between
languages:

```ts
// No:  'Installed ' + count + ' games on ' + drive
// Yes: t('installs.done', { count, drive })   en: "Installed {count} games on {drive}"
```

- Variables are `{name}`; pass every one used. Values are inserted as given (format numbers, sizes and dates
  yourself before passing them).
- Plurals: pass `count` (a number) and give English `key_one` and `key_other`:
  `"games_one": "{count} game", "games_other": "{count} games"`, used as `t('ns.games', { count: n })`.
  Other languages add the forms they need (`_few`, `_many`...: Intl.PluralRules). Spanish uses `_one`/`_other`.
- Mixed markup (a link or bold word inside a sentence): split into a sentence with a `{link}` variable and the
  link's own text as a second key, then render the pieces; do not split the sentence itself.
- If a string mixes user text with translated text, the user text is a variable.

## Checks before you finish

A new namespace file can look missing to the tests (its keys reported as absent from English) while the app sees it:
vitest caches the transformed `src/shared/i18n/index.ts`, glob result included, in `node_modules/.vitest-cache`.
Delete that folder and run the tests again.

```bash
npx vitest run src/shared/i18n   # keys used exist in English; Spanish keys and {variables} match English
npm run i18n:check               # coverage: Spanish should stay at 100%
npm run -s typecheck
```

The setting itself is `settings.system.language` (a code; '' until main's first-start detection fills it), shown
in Settings › System › Language. Do not confuse it with `settings.scrapers.language` (metadata language).
