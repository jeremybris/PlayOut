# PlayOut metadata relay: setup

The relay is a small Cloudflare Worker. When someone who is not the owner edits a game's metadata in PlayOut and
saves it, PlayOut sends the change here; the relay checks it and opens a pull request on
`jeremybris/PlayOut-metadata` labelled `suggestion`. Merge the PR to approve the change (it then reaches every
PlayOut through `all.json`), close it to reject it. Nobody needs a GitHub account to suggest, and you do not need a
second one either: the relay signs in as a **GitHub App** that you create in your own account. Its pull requests
show as `<app name>[bot]` (for example `playout-metadata[bot]`). The repository's ruleset (step 5b) lets the app
write nothing but `suggest/...` branches and pull requests, and new rows on the separate `database` branch (the
PlayOut database, below): only you can change `main`. The relay's code refuses
any other branch as well, so neither a relay bug nor a leaked app key can publish metadata without your approval.

A credential cannot live inside PlayOut itself (anyone could pull it out of the app), which is why the relay holds
it on Cloudflare's side.

Everything below runs on Cloudflare's free plan. Commands run in a terminal (Windows PowerShell works) opened in
this folder (`PlayOut\metadata-relay`), one command at a time.

## 1. Prerequisites

- Node.js 20 or newer (`node -v`).
- The repository `jeremybris/PlayOut-metadata` exists on GitHub with a `main` branch (it may start empty apart
  from a README).
- In that repository, create the label once: **Issues › Labels › New label**, name `suggestion`.
- Recommended: **Settings › General › Pull Requests › Automatically delete head branches**, so the
  `suggest/...` branches go away when a PR is merged or closed.

## 2. Create a free Cloudflare account

1. Go to <https://dash.cloudflare.com/sign-up> and sign up (the free plan is enough; no domain needed).
2. Confirm the e-mail address.

## 3. Install the tools and sign in

```powershell
npm install
```

```powershell
npx wrangler login
```

`npm install` installs Wrangler (Cloudflare's CLI) into this folder; use it through `npx wrangler` (a global
`npm i -g wrangler` works too). `wrangler login` opens the browser; allow access for your Cloudflare account.

## 4. Create the rate-limit store (KV)

The relay counts suggestions per IP address (an IPv4 address on its own; IPv6 per `/64`, the block one connection
usually holds, so rotating addresses inside it does not help), per IPv6 `/48` (ISPs delegate a `/56` or `/60` to a
home and cloud providers often a whole `/48`, so one subscriber could otherwise rotate through hundreds of `/64`s),
per PlayOut install and in total, per hour, in a Workers KV namespace
(KV works on the free plan and allows hourly windows; Cloudflare's Rate Limiting binding only counts per 10 or 60
seconds).

```powershell
npx wrangler kv namespace create RATE_LIMIT
```

It prints an `id`. Open `wrangler.toml` and put it as the `id` under `[[kv_namespaces]]` (already done for
`jeremybris`'s relay).

The limits are the `RATE_*_PER_HOUR` values in `wrangler.toml` (set to 40 per IP, 60 per IPv6 `/48`
(`RATE_IP48_PER_HOUR`), 30 per PlayOut install, 120 in total per hour; the code's defaults without them are the same
numbers, `DEFAULT_RATE_LIMITS` in `src/ratelimit.ts`: change both together, and with the per-install limit also
`RELAY_SUGGESTIONS_PER_HOUR` in PlayOut's `src/shared/metadata-cloud.ts`, which is what the app tells the user).
Each accepted suggestion costs 3 KV writes
(4 from IPv6); the free plan allows 1,000 a day, so about 250-330 suggestions a day in all on that plan.

A suggestion counts against these limits only when it becomes a pull request. One the relay turns away after asking
GitHub (it matches the cloud record already, too many wait for review, GitHub failed) is counted separately, per
address and in total with the same limits (2 KV writes, 3 from IPv6): it costs the sender none of the hour's
suggestions, and cannot be repeated without end either.

On top of that, the relay takes no new suggestion while `MAX_OPEN_SUGGESTIONS` (300 here, and without it:
`DEFAULT_MAX_OPEN_SUGGESTIONS` in `src/index.ts`) suggestion pull
requests (from `suggest/` branches) are open: it answers 429 with `Retry-After: 3600` until you have approved or
rejected some, so spam that gets past the hourly limits cannot pile up without end. PlayOut keeps such edits
waiting and tries again later. (A suggestion for a game whose suggestion is open already still goes through: it
updates that pull request and adds none; see "What the relay accepts" below.)

## 5. Lock `main` and create the relay's GitHub App

The relay must not use a token of your own account: GitHub cannot tell two tokens of the same account apart, so a
rule that lets you publish would let a leaked relay token publish too. A GitHub App is a separate identity that
you own and control from your account: it gets only the permissions you give it, only on the repository you
install it on, and the ruleset below does not let it bypass anything. The relay signs a short-lived request with
the app's private key and gets a one-hour token from GitHub, which it reuses until shortly before it expires;
no long-lived token is stored.

### 5a. Create the GitHub App

Signed in as `jeremybris`:

1. Avatar › **Settings › Developer settings › GitHub Apps › New GitHub App**.
2. **GitHub App name**: for example `PlayOut metadata` (it must be unique on GitHub; its pull requests show as
   `<name>[bot]`).
3. **Homepage URL**: `https://github.com/jeremybris/PlayOut-metadata`.
4. **Webhook**: uncheck **Active** (the relay needs no webhook).
5. **Repository permissions**, exactly:
   - **Contents: Read and write** (create a `suggest/...` branch and commit `games/<key>.json` on it, rebuild it
     when a later suggestion for the same game updates its pull request)
   - **Pull requests: Read and write** (open the PR and add the `suggestion` label; update its description, or
     comment on and close it, when a later suggestion for the same game changes it)
   - **Metadata: Read-only** (GitHub sets it automatically)
   - Everything else **No access**, **Workflows** in particular (without it the app cannot change the
     repository's GitHub Actions, not even on a `suggest/...` branch). No organization or account permissions.
6. **Where can this GitHub App be installed?**: **Only on this account**.
7. **Create GitHub App**.
8. On the app's page, note the **App ID** (a number near the top).
9. Further down, **Private keys › Generate a private key**. The browser downloads a `.pem` file (for example
   `playout-metadata.2026-11-16.private-key.pem`). You need it once, in step 6.

### 5b. The ruleset: only you change `main`, the app only writes `suggest/...`

This is already set up on `jeremybris/PlayOut-metadata`; the steps are here to check it or to set it up again.

As `jeremybris`: `PlayOut-metadata` › **Settings › Rules › Rulesets › New ruleset › New branch ruleset**.

1. Name: `Only the owner changes main`. Enforcement status: **Active**.
2. **Bypass list › Add bypass**: **Repository admin** (that is you; your own publishes from PlayOut and your
   merges of suggestions keep working) and **Deploy keys** (the `Build all.json` Action, see below). Do **not**
   add the GitHub App.
3. **Target branches › Add target › Include all branches**, then **Exclude by pattern** `suggest/**`, and
   **Exclude by pattern** `database` too (the PlayOut database's branch, which the app commits to and which has a
   ruleset of its own; see "PlayOut database" below).
4. Rules, turn on:
   - **Restrict creations**, **Restrict updates**, **Restrict deletions**, **Block force pushes**;
   - **Require a pull request before merging** (required approvals: 0).
5. **Create**.

Result: the app can create, update and delete `suggest/...` branches and open pull requests from them, but it
cannot push to, merge into or delete `main` (or create any other branch), because it is not on the bypass list.
The one other branch it writes is `database` (new rows of the PlayOut database, never force-pushed or deleted).
Only a bypass actor, which is you, can merge a suggestion. Check it once: in the ruleset's **Insights** tab, or by
merging a test suggestion yourself.

On a personal repository GitHub does not offer GitHub Actions in the bypass list, so the `Build all.json` Action
pushes with a deploy key instead (this is how `jeremybris/PlayOut-metadata` is set up): the ruleset's bypass list
has **Repository admin** and **Deploy keys**, and the workflow checks out with
`ssh-key: ${{ secrets.ALL_JSON_DEPLOY_KEY }}`. To create the key again, run these one at a time (press Enter twice
at the passphrase prompts, for none):

```powershell
ssh-keygen -t ed25519 -f allkey
```

```powershell
gh repo deploy-key add allkey.pub --repo jeremybris/PlayOut-metadata --allow-write --title "all.json builder"
```

```powershell
Get-Content allkey -Raw | gh secret set ALL_JSON_DEPLOY_KEY --repo jeremybris/PlayOut-metadata
```

```powershell
Remove-Item allkey, allkey.pub
```

The GitHub App has no access to secrets or workflows, so it cannot use the key. Pushes from a plain `git push`
may be refused even for you (they go through Git's own sign-in); PlayOut and `gh` write through GitHub's API,
which the admin bypass covers.

### 5c. Install the app on the repository

On the app's page (**Settings › Developer settings › GitHub Apps › PlayOut metadata › Edit**): **Install App** ›
next to `jeremybris`, **Install** › **Only select repositories** › `PlayOut-metadata` › **Install**.

The relay finds the installation by itself. If you want to skip that lookup, the number at the end of the
installation page's URL (`.../settings/installations/<number>`) is the installation id; it can be given as the
optional secret `GITHUB_APP_INSTALLATION_ID` (step 6).

The app's key is not the token you paste into PlayOut as the owner (that one belongs to your own account); keep
the two separate.

**If the app's private key leaks** (or the Cloudflare account does): whoever has it can open, edit and close pull
requests and push `suggest/...` branches, i.e. send spam suggestions. They cannot change `main`, `all.json` or
`config.json`, so nothing reaches any PlayOut without your merge. On the app's page, first **Generate a private key**
for a new one (GitHub keeps at least one key, so the leaked one can only be deleted after), put the new one into the
relay (step 6), then delete the leaked key under **Private keys**, and delete stray `suggest/...` branches.

## 6. Give the app's credentials to the relay

Run this and type the App ID from step 5a when asked:

```powershell
npx wrangler secret put GITHUB_APP_ID
```

Then the private key, straight from the downloaded file (replace the path with yours; keep the quotes):

```powershell
Get-Content "$HOME\Downloads\playout-metadata.2026-11-16.private-key.pem" -Raw | npx wrangler secret put GITHUB_APP_PRIVATE_KEY
```

Optional, only if you noted the installation id in step 5c:

```powershell
npx wrangler secret put GITHUB_APP_INSTALLATION_ID
```

Both are stored encrypted by Cloudflare and never appear in `wrangler.toml` or in this folder. Then delete the
`.pem` file (a new key can be generated any time on the app's page):

```powershell
Remove-Item "$HOME\Downloads\playout-metadata.2026-11-16.private-key.pem"
```

The relay accepts the key as GitHub hands it out (`BEGIN RSA PRIVATE KEY`) or as PKCS#8 (`BEGIN PRIVATE KEY`).
A relay set up earlier with a `GITHUB_TOKEN` secret keeps working with it while no app is configured; once
`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are set, the app is used and the old secret can go:

```powershell
npx wrangler secret delete GITHUB_TOKEN
```

## 7. Deploy

```powershell
npx wrangler deploy
```

It prints the worker's URL, for example `https://playout-metadata-relay.<your-subdomain>.workers.dev`. Check it:
open `<that URL>/health` in a browser; it should show `{"ok":true}`.

## 8. Connect PlayOut

In PlayOut: **Settings › Metadata › Cloud**, paste the worker URL (without `/health`) into the relay field and
save. From then on, a metadata edit saved by anyone without the owner token is sent to the relay and shows up as a
pull request from `<app name>[bot]`.

## PlayOut database

The relay also feeds the **PlayOut database**: each game's stable facts (title, platform, release date, genres,
Steam tags, developers, publishers, local players) as plain CSV files under `data/<prefix>/<nn>.csv`. It lives in
the same repository as the metadata cloud, on a branch of its own: the **`database` branch** of
`jeremybris/PlayOut-metadata` (https://github.com/jeremybris/PlayOut-metadata/tree/database; PlayOut reads it from
`https://raw.githubusercontent.com/jeremybris/PlayOut-metadata/database/data/<prefix>/<nn>.csv`). `main` stays as it
is: only you change it, and metadata edits from others arrive as `suggest/...` pull requests that you approve.

Every PlayOut reads the database to fill a game's facts first, and sends the games it lacks to `POST /contribute`.
Unlike suggestions, these are not pull requests: the relay commits new rows straight to the `database` branch, as
the same GitHub App. It only ever **adds** rows for games the database does not have yet; a row that is there is
never changed or removed (corrections still go through suggestions into `main`). The relay's code refuses to write
any other repository, any other branch (`main` and `suggest/...` included) or any file outside
`data/<prefix>/<nn>.csv`; and its `/suggest` code still writes nothing but `suggest/...` branches.

What you do once:

1. **Let the app push to the `database` branch, and only that one.** In `PlayOut-metadata`, **Settings › Rules ›
   Rulesets**, open the ruleset of step 5b (`Only the owner changes main`, the one that targets all branches except
   `suggest/**`) › **Target branches › Add target › Exclude by pattern** `database` › **Save changes**. Its targets
   are then: all branches, except `suggest/**` and `database`. `main` keeps every rule it had, and the app still
   cannot create any other branch.

   Then add a small ruleset that keeps the database's history: **New ruleset › New branch ruleset**:
   - Name: `Keep the database history`; Enforcement status: **Active**; no bypass list.
   - Target branches: **Add target › Include by pattern** `database`.
   - Rules: tick only **Restrict deletions** and **Block force pushes**. Leave **Restrict updates**, **Require a
     pull request before merging** and the others off: the app has to commit to this branch, and GitHub does not
     offer an app as a bypass actor on a personal repository.
   - **Create**.

   Every row the relay adds is then an ordinary commit on `database` (`Add 3 games from PlayOut`) that nobody can
   rewrite away; you can still edit or remove rows yourself through normal commits.

2. **App access: nothing to add.** The app's installation already covers `PlayOut-metadata` (step 5), so no new
   repository, permission or secret is needed. For `/contribute` the relay asks GitHub for a token with **Contents:
   write only** on this repository (no pull requests), a part of what the app is already granted.

3. **Create the `database` branch** (once, as you; you are a bypass actor, so the rulesets do not stop you). It is
   an orphan branch, with no history shared with `main`, holding the template from PlayOut's `database-repo/`
   folder (`README.md`, `.gitattributes`, `data/.gitkeep`). In PowerShell, in a folder outside PlayOut:

   ```powershell
   git clone https://github.com/jeremybris/PlayOut-metadata.git PlayOut-db-branch
   cd PlayOut-db-branch
   git switch --orphan database
   Copy-Item -Recurse -Force <PlayOut source folder>\database-repo\* .
   git add -A
   git commit -m "Start the PlayOut database"
   git push -u origin database
   ```

   (`git switch --orphan` empties the working folder of `main`'s files; check with `git status` that only the
   three template files are staged before committing.) The relay creates the `data/...` files as games arrive, and
   PlayOut reads a missing file as an empty database. The `Build all.json` Action runs on `main` only and does not
   look at this branch.

4. **Deploy** the relay again, which brings the `DB_*` and `RATE_DB_*` values of `wrangler.toml`
   (`DB_REPO_NAME = "PlayOut-metadata"`, `DB_BRANCH = "database"`) and creates the `DB_LIMITS` Durable Object that
   counts contributions (its `[[migrations]]` entry; the free plan allows it):

   ```powershell
   npx wrangler deploy
   ```

   Without them, or if they name anything but `jeremybris/PlayOut-metadata` on the `database` branch (`main`
   included), `/contribute` answers 503 and writes nothing.

Limits: `RATE_DB_*_PER_HOUR` in `wrangler.toml` (12 requests per PlayOut install, 20 per IP, 40 per IPv6 `/48`, 30
in total per hour; one request carries up to 25 games), counted apart from the suggestions in the `DB_LIMITS`
Durable Object. It counts one request at a time, so requests sent at the same moment cannot slip past a limit as
they can with KV, and it uses none of the KV namespace's 1,000 free writes a day. A request whose games are all in
the database already takes none of the hour's contributions. Only games on a platform PlayOut knows (`pc` and the
systems of PlayOut's `resources/systems/systems.json`, copied in `src/platforms.ts`) are taken, and never programs
added by hand (`manual-` keys, made from folder names on the user's disk). If the app's key leaks, whoever has it
can commit to the `database` branch (and open suggestions, as before), but cannot touch `main`, force-push or delete
the branch, so history is never lost: rotate the key as described in step 5c and revert the commits.

## Recompilation suggestions

PlayOut's Recompilations browser has an **Add** button: a user pastes a GitHub repository the catalogs do not list,
PlayOut checks it (public, a release with a Windows download) and shows it at once as "Added by you"; then the owner's
PlayOut publishes it to `recomps/<owner>__<repo>.json` on `main`, and everyone else's sends it to
`POST /suggest-recomp`. The relay reads the repository again (public, not disabled; its current name), reads its
newest releases (one that is not a draft must carry a download), and opens a pull request from
`suggest/recomp/<owner>__<repo>-<id>` that adds only that file, labelled `recomp-suggestion`. One PlayOut lists
already (the file is on `main`) answers 409; a repository with an open suggestion answers with that pull request and
writes nothing. Recompilation pull requests have a backlog of their own: no new one while `MAX_OPEN_RECOMP_SUGGESTIONS`
(30; default `DEFAULT_MAX_OPEN_RECOMP_SUGGESTIONS` in `src/index.ts`) `suggest/recomp/` pull requests are open, and
they never count toward `MAX_OPEN_SUGGESTIONS` (a pile of them cannot stop the game suggestions). PlayOut's owner
screens do not list them: review them on github.com (label `recomp-suggestion`). The console must be one of PlayOut's
(`src/recomp-consoles.ts`, the same list as `recomp-schema.json`), and the game and blurb hold no tabs or other
control characters, so a record the relay writes is always one `check.yml` passes and every PlayOut keeps.

What you do once:

1. **Nothing in the rulesets.** `suggest/recomp/...` branches are under `suggest/**`, which the app may already
   write (step 5b), and `check.yml` holds them to `recomps/*.json` by their branch name.
2. **Push the metadata repository first** (its `recomp-schema.json`, `scripts/` and workflows, from PlayOut's
   `metadata-repo/`): the check workflow reads its rules from `main`.
3. **Deploy** the relay (`npx wrangler deploy`). It brings the `RATE_RECOMP_*` values; the counters live in the
   existing `DB_LIMITS` Durable Object under a name of their own (`playout-recomps`), so no new class or migration is
   needed. Without `DB_LIMITS`, `/suggest-recomp` answers 503.
4. **Check it reads other repositories.** The reads use the app's installation token, which GitHub lets read public
   repositories outside the installation; if it ever cannot, the request fails with 502 (it never falls back to
   reading without signing in). Try it once:

   ```powershell
   curl.exe -s -X POST https://<your relay>/suggest-recomp -H "Content-Type: application/json" `
     -d '{"url":"https://github.com/does-not/exist-xyz","game":"Test","systemId":"other","appVersion":"0.0.1","clientId":"setup-check-01"}'
   ```

   `400` with "the repository was not found" means it works (GitHub answered); `502` means the token cannot read
   other repositories; `404 not found` means the deployed relay is older than this code.

Limits: `RATE_RECOMP_*_PER_HOUR` in `wrangler.toml` (5 per PlayOut install, 10 per IP, 15 per IPv6 `/48`, 30 in total
per hour), checked before GitHub is asked anything; a request turned away counts apart and takes none of the hour's
suggestions. A refused repository (missing, private, no release with a download, a name that cannot be stored)
counts against its address and in a total of its own, `RATE_RECOMP_TURNED_AWAY_GLOBAL_PER_HOUR` (400), far above the
accepted ones, so a few addresses cannot block every honest suggestion for the hour; "listed already" (409) and
"suggested already" count against the sender's address only. A repository name the relay cannot store (`..`, a
trailing `.`) answers 400, never 502 (which PlayOut would retry).

## Maintenance

- Logs: `npx wrangler tail` shows requests live (validation errors and GitHub failures are logged; keys and
  tokens never are).
- New private key: generate it on the app's page, put it in with the `GITHUB_APP_PRIVATE_KEY` command of step 6
  (no redeploy needed), then delete the old key on the app's page.
- Code changes: `npm test`, then `npx wrangler deploy`.

## What the relay accepts

`POST /suggest-recomp` with `Content-Type: application/json`, at most 64 KB:

```json
{
  "url": "https://github.com/Zelda64Recomp/Zelda64Recomp",
  "game": "The Legend of Zelda: Majora's Mask",
  "systemId": "n64",
  "blurb": "Static recompilation of Majora's Mask for PC.",
  "appVersion": "0.9.92",
  "clientId": "a-random-install-id"
}
```

`url` is exactly `https://github.com/<owner>/<repo>` (an optional trailing `/`; no `.git`, query or hash); `systemId`
is `other` or a system of `src/platforms.ts`; `game` (at most 200 characters) and `blurb` (optional, at most 500)
are one line of plain text. Anything else is refused with 400.

`POST /suggest` with `Content-Type: application/json`, at most 64 KB:

```json
{
  "key": "steam-620",
  "title": "Portal 2",
  "fields": { "genres": ["Puzzle"], "hltb": { "main": 8.5 } },
  "appVersion": "0.1.138",
  "clientId": "a-random-install-id"
}
```

- `key`: the game key, as PlayOut's `gameMetadataKey` makes it (`steam-<appid>`, `<store>-<id>`,
  `<systemId>-<serial or title>`, `<title>`): lowercase `a-z 0-9 . _ -`, no `..`, at most 250 characters.
- `fields`: only the editable metadata fields (PlayOut's `MetadataEdit`) — `title`, `description`,
  `shortDescription`, `releaseDate` (`YYYY`, `YYYY-MM`, `YYYY-MM-DD` or `''`), `developers`, `publishers`,
  `genres`, `tags`, `localPlayers` (0-64), `controls {controller: full|partial|none, vr: only|supported|none}`,
  `hltb {main, extra, completionist, solo}` (hours), `reviewScore {score 0-100, source: steam|igdb}`. An empty
  value (`''`, `[]`, `0`, `{}`) is a correction meaning "the game has none"; a field set to `null` asks for it to
  be removed from the cloud record. Text with HTML tags or script URLs is refused. Artwork and other media are not
  part of the cloud record (they stay local in PlayOut).
- `clientId`: 8-64 characters `A-Z a-z 0-9 _ -`; `appVersion`: PlayOut's version.

Answers: `{ "ok": true, "pr": { "number": 12, "url": "https://github.com/..." } }` (with `"updated": true`
when the suggestion went into a pull request that was open already, see below), or
`{ "ok": false, "error": "..." }` with status 400 (invalid), 409 (nothing would change), 413 (too large),
415 (not JSON), 429 (rate limited, or too many suggestions wait for review; with `Retry-After`), 502 (GitHub refused) or 503 (relay not configured).

The suggestion is merged onto the current `games/<key>.json` on `main` (each suggested field replaces the whole
field, as in PlayOut; the fields it leaves out stay as they are) and
committed on a new branch `suggest/<key>-<id>`; `main` itself is never written by the relay (its code only writes `suggest/` branches, and the ruleset of step 5b refuses anything else).

A game has at most one open suggestion pull request. Two of them would both change (or both create) the same
`games/<key>.json`, and once one is merged the other conflicts in a way GitHub's web editor cannot resolve. So a
suggestion for a game that has one open already (a pull request labelled `suggestion`, or opened by the app, from
a `suggest/<key>-...` branch of this repository into `main`) updates that pull request instead of opening another:

- What it suggested (its file against the commit it was made from) and the new suggestion are combined, the newest
  value winning per field, and compared with the current `main`.
- The branch gets one new commit: `main`'s current files with the combined record, on top of both the branch's head
  and `main`'s head. The pull request therefore always shows a clean change against today's `main` and never goes
  stale (its commit list keeps the earlier commits). The branch only ever moves forward, never by a forced push: if
  another suggestion for the game moved it in the meantime, GitHub refuses the move, and the relay combines again
  with what the branch has now (once; if that is refused too, it answers 502 and PlayOut sends the suggestion
  again), so neither suggestion is lost. The title stays; the body's table shows the combined change, and its
  "Suggestions as sent" log keeps each suggestion (oldest first; the oldest are left out past about 24,000
  characters, and each is cut at 6,000).
- If the combined change is nothing at all (the newest suggestion takes every field back to the cloud value), the
  relay closes the pull request, then adds a comment saying why, deletes its branch and answers 409, as for any
  suggestion that changes nothing. (If GitHub refuses the close, the pull request stays as it was and the answer is
  502.) The same suggestion sent again changes nothing and writes nothing (200, `updated`).
- Only a real change takes one of the hour's suggestions, as before; an update adds no pull request, so it is
  accepted even while `MAX_OPEN_SUGGESTIONS` are open: past the cap the relay keeps paging (within the 5 pages
  below) until it finds the game's pull request. One further back than 500 open pull requests is not found, and
  the suggestion is turned away with 429.

Two suggestions for one game sent at the same moment can both find none open and open one each: right after
opening its pull request, the relay looks at the newest open ones, and if an earlier one for the same game is
there, it puts its suggestion into that one and closes its own (with a comment) and deletes its branch. The earlier
one counts when it is labelled `suggestion`, opened by the app, or opened under the same login as the relay's own
(a relay running on `GITHUB_TOKEN` opens its pull requests as that token's user, and the other request may not have
added the label yet).

A /suggest request makes at most about 35 GitHub calls, sign-in included (the relay pages through at most 5 pages of
100 open pull requests, so `MAX_OPEN_SUGGESTIONS` works up to 499; an update takes at most 24, a new pull request
that folds into an earlier one at most 33), inside Workers' 50 subrequests.

`POST /contribute` with `Content-Type: application/json`, at most 64 KB:

```json
{
  "clientId": "a-random-install-id",
  "appVersion": "0.9.40",
  "rows": [
    {
      "key": "steam-620",
      "title": "Portal 2",
      "platform": "pc",
      "releaseDate": "2011-04-18",
      "genres": ["Puzzle"],
      "tags": ["Co-op", "Puzzle"],
      "developers": ["Valve"],
      "publishers": ["Valve"],
      "localPlayers": 2,
      "steamAppId": 620
    }
  ]
}
```

- `rows`: 1 to 25 games, each a row of the database (PlayOut's `GameDbRow`, `src/shared/game-database.ts`; the
  relay's copy of the format is `src/database-format.ts`). A missing list reads as `[]`, a missing `releaseDate` as
  `''`, a missing number as `null`; any other property refuses the row. Each row is checked on its own: the format's
  rules (no text that starts like a spreadsheet formula, no control characters, no `|` inside a value, limits), a
  key `gameMetadataKey` makes (never an added program's `manual-` key), `platform` `pc` for a store's game and the
  key's system (one PlayOut knows) for a ROM, and a Steam key's `steamAppId` equal to its id. Refused rows are
  reported; the others go on.

Answers: `{ "ok": true, "added": [keys], "present": [keys], "refused": [{ "key", "error" }], "later": [keys] }`:
`added` are new rows now on the `database` branch, `present` were in the database already (left as they are), `refused` failed the
checks (do not send them again), `later` were not written this time (GitHub failed part way, the request needed
more GitHub calls than one request may make, or a rate limit filled up part way): keep them and send them again
after the answer's `Retry-After` seconds (present whenever `later` is not empty: until the limit's hour ends when a
rate limit stopped it, else a minute). Or `{ "ok": false, "error": "..." }` with status 400 (invalid, or no row can
go in; then with `refused`), 413, 415, 429 (rate limited; with `Retry-After`), 502 (GitHub refused) or 503 (relay
not configured for the database, or its rate-limit counters did not answer; then with `Retry-After`).
