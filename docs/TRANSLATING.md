# Translating PlayOut

PlayOut's menus and messages live in plain JSON files, one folder per language. English is the source: every
string exists there first, and anything a translation leaves out shows in English. Adding a language needs no code
change, only a new folder.

```
src/shared/i18n/locales/
  en/                    English (the source)
    _language.json       the language's name and status
    settingsSystem.json  one file per area of the app (a "namespace")
    ...
  es/                    Spanish (machine translated for now)
    _language.json
    settingsSystem.json
```

Game names, descriptions and other details come from the stores and metadata sources and are not translated here
(Settings › Metadata has its own language for those).

## Add a language

1. Copy `src/shared/i18n/locales/en` to a folder named after the language's code: `fr`, `de`, `pt-BR`,
   `zh-CN` (a [BCP 47](https://www.rfc-editor.org/info/bcp47) code, the region only when it matters).
2. Edit `_language.json` in the new folder:

   ```json
   {
     "code": "fr",
     "name": "French",
     "nativeName": "Français",
     "machineTranslated": false,
     "notes": "Who translated it, what is left."
   }
   ```

   `nativeName` is what Settings › System › Language lists. Set `machineTranslated` to `true` for text from a
   translation tool that no speaker has checked yet: the setting then says "(machine translated)".

3. Translate the values (the text on the right), file by file. A file or a string you have not translated yet can
   be left out: PlayOut shows the English one.
4. Run the check (below), then try it.

Once the folder has a `_language.json`, PlayOut offers the language. PlayOut also picks it on its first start for
anyone whose Steam or Windows language it is (es-MX and es-419 use `es`; `pt` uses `pt-BR` when that is the only
Portuguese).

## Rules

- **Translate values, never keys.** In `"freeNow": "Free memory now"`, only `Free memory now` changes. Keep the
  same nesting as English.
- **Keep `{variables}` exactly as written**, in braces: `"{language} (machine translated)"` becomes
  `"{language} (traduction automatique)"`. Move them where your grammar needs them; do not translate the name
  inside the braces, and do not add new ones.
- **Plurals.** A string that depends on a number has one key per plural form, named `<key>_<form>`, with the forms
  your language uses (from [CLDR](https://cldr.unicode.org/index/cldr-spec/plural-rules): `zero`, `one`, `two`,
  `few`, `many`, `other`). English uses `one` and `other`:

  ```json
  { "games_one": "{count} game", "games_other": "{count} games" }
  ```

  Polish, for example, adds `few` and `many`. `_other` is always needed: it is used for any form you leave out.

- **Keep it short.** PlayOut is used from a couch with a controller: labels sit on buttons and narrow rows. Prefer
  the shorter wording when two mean the same.
- **One word for one thing.** Pick a term for each idea (Settings, controller, the overlay, Home button, delete,
  select) and use it in every file, so a path such as "Settings › System" names the screen the player lands on.
  Mixing regional variants is the usual slip. The Spanish files use Spain's Spanish: Ajustes, mando, ratón, añadir,
  pulsar, el PC, superposición, botón Home, handler (Nucleus Co-Op). A Latin American version can go in its own
  `es-419` folder; PlayOut then picks it for Windows' es-419 and Steam's `latam` (other regions such as es-MX
  still go to `es`).
- **Brand and product names stay**: PlayOut, Steam, Xbox, RetroAchievements, Dynamic TDP, Bluetooth and the like.
- **Same tone as English**: plain, direct, no exclamation marks.
- The files are UTF-8 JSON: write accents and other letters as they are (`"Español"`), and escape only `"` and `\`.

## Check and test

```bash
npm run i18n:check          # every language: strings translated, missing ones, errors
npm run i18n:check -- fr    # one language; add --missing to list every missing string
npm run test:unit           # the same errors fail the tests (src/shared/i18n/locales.test.ts)
```

The check reports errors for keys English does not have (a typo or a key English dropped) and for `{variables}`
English does not use. Missing strings are only reported: they show in English.

To see the translation, run PlayOut (`npm run dev`, or `npm run dev:web` for the browser version) and pick the
language in **Settings › System › Language**. It applies at once, no restart.

## Fix a translation

Find the English text in `src/shared/i18n/locales/en/*.json`, note its key, and change the same key in your
language's file. A language marked `machineTranslated` that a speaker has reviewed can set it to `false`.

## For developers

How code reads these strings, what counts as user-facing text and how to move text into the files:
[src/shared/i18n/EXTRACTION.md](../src/shared/i18n/EXTRACTION.md).
