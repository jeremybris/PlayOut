# Emulation folder sync

Settings › Streaming › **Sync the Emulation folder** keeps the data Emulation folder (BIOS, saves, states, storage…)
the same on a streaming host and its paired clients, **both ways**. It is on by default, and both PCs need it on. The
code lives in `src/main/streaming/emulation-sync/`.

## What syncs

Everything in the Emulation folder except:

- `roms` and `texturepacks` at its top, with everything in them (any letter case);
- the ROM folder, when Settings › Library puts it inside the Emulation folder under another name. The host sends its
  own such folder (`manifest.excluded`), and the client leaves it alone too;
- links (junctions, symbolic links). They are never followed, copied or written through (`realInside`), and nothing
  at or under them syncs on either PC. Cloud placeholders (OneDrive) are not links: `lstat` tells them apart;
- PlayOut's own leftovers: `*.playout-sync`, `*.playout-new` and `*.playout-old[-n]` names, `.playout-sync-id`, and
  the host's upload staging folder `uploads.playout-sync`.

## How a pass works

Only the host runs a server, so the client drives each pass, one host at a time. A pass runs:

- after each refresh that reached a host (every 5 minutes);
- when the setting is turned on;
- 30 s after a game ends.

A pass does not run while a game runs on either PC. The host refuses with `409 busy`.

1. **Host list.** The client fetches the host's file list (`GET /v1/emulation/manifest`): every file's path, size,
   modified time and SHA-1. The list also carries:
   - the host folder's id;
   - the host clock, stamped as the answer leaves;
   - unreadable files, links and extra exclusions.
2. **Local scan.** The client scans its own folder. Hashes are cached in `client-index.json` and `host-index.json`,
   keyed by size and modified time, and saved every 15 s while hashing.
3. **Merge.** A three-way merge (`plan.ts`) compares each file on this PC and on the host with the **base**: the
   hashes both had after the last sync with that host (`hosts/<host>.json`, client side).
   - Changed on one side only: the change goes to the other side, as a copy or a deletion.
   - Changed on both sides: the newer modified time wins, with the host's time put on this PC's clock; a tie goes to
     the host. The losing copy goes to the backups. A deletion never beats a change.
   - No base yet (first sync), or a folder that is not the one last synced (its `.playout-sync-id` differs or is
     missing: new, moved, emptied, another drive): both folders are merged, and nothing is deleted.
   - Held for a later pass: files written in the last 30 s on either PC (by that PC's clock), and files that could not
     be read.
4. **Transfers.**
   - Downloads go to `<file>.playout-sync` and are checked against the host's hash before one rename puts them in
     place.
   - Uploads go in 512 KiB pieces (`PUT /v1/emulation/upload`) into `<host Emulation>\uploads.playout-sync`, on the
     same drive as the target. `POST /v1/emulation/commit` then checks the whole file and the client's `expect`ed
     host copy (`409 changed` otherwise) and renames it over the target in one step.
   - Deletions (`POST /v1/emulation/delete`) check the expected hash the same way.
   - A file the host cannot replace refuses just that file (`409 host-file`). A transfer that fails is retried next
     pass. Three in a row end the pass.
5. **Base.** The base advances only for the files that were really moved. It is saved every 15 s and when the pass
   ends.

## Backups

Kept in `userData\streaming\emulation-sync\backups\<date>\<path>` for 30 days. They are outside the Emulation folder,
so they never sync. Two kinds of file go there:

- a copy that lost a conflict (copied before the replace, and only once per content);
- a file deleted because the other PC deleted it (moved).

## Status

Each paired host's card in Settings › Streaming shows one line, for example:

- "Emulation folder synced 4 min ago"
- "syncing, 3 of 12 files"
- "waiting (a game is running on Living Room PC)"
- the error, when there is one

The line also shows conflicts and failures from the last pass.
