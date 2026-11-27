# PlayOutXbox

PlayOut's Xbox / Xbox 360 disc image helper: a small C# console program on the MIT libraries
[XISOSharp](https://github.com/purelogiccode/XISOSharp) (with CCISharp, ZArchiveSharp, StfsSharp) and
[CHDSharp](https://github.com/purelogiccode/CHDSharp), the engine of XISO Studio. PlayOut runs it from
`resources\xbox\PlayOutXbox.exe`; `node scripts/build-xbox-helper.mjs` rebuilds that folder (needs the .NET 10 SDK).

## Commands

```
PlayOutXbox trim    <in.iso> <out.iso>                      [--overwrite]
PlayOutXbox extract <image> <outDir>
PlayOutXbox pack    <inDir> <out.iso>                       [--overwrite]
PlayOutXbox zar     <in.iso | inDir> <out.zar>              [--overwrite]
PlayOutXbox chd     <in.iso> <out.chd>                      [--overwrite]
PlayOutXbox toiso   <in.chd | in.zar | in.cso | in.cci> <out.iso>  [--overwrite]
PlayOutXbox info    <image>
PlayOutXbox read    <in.chd> <offset> <length>
PlayOutXbox --version | --help
```

- **trim**: a Redump dump (video partition + game partition; XGD1, XGD2, XGD2-Hybrid, XGD3) or a plain Xbox /
  Xbox 360 image becomes an optimized XISO: game partition only, extract-xiso optimized layout, no padding (what
  XISO Studio's Convert does). An image that already is an optimized XISO is not rewritten:
  `{"type":"done","skipped":"already optimized",...}` (after a structural audit). `$SystemUpdate` is kept, and `.xbe`
  files are not media-patched, so every file stays byte-identical to the disc.
- **extract**: the whole image (ISO, Redump ISO, CSO, CCI, CHD or ZAR) to a folder; names Windows cannot hold
  (`aux.txt`, `con`, a trailing dot) are sanitized (`renamed` in the result). The folder must not exist or be empty.
- **pack**: a game folder (an extracted disc) back into an XISO (`XisoWriter.PackFromDirectory`), audited and
  compared with the folder: same files, sizes and SHA-256.
- **zar**: an ISO (its game partition) or a folder to a ZArchive (Xenia's `.zar`, zstd level 6).
- **chd**: an Xbox DVD to CHD v5 with chdman's `createdvd` preset (4096-byte hunks, 2048-byte units,
  `lzma,zlib,huff,flac`, DVD metadata). Like XISO Studio, the CHD holds the optimized XISO: a Redump or
  unoptimized image is trimmed first (into `<out>.playout-partial-source.iso` beside the output, deleted after).
- **toiso**: CHD (DVD), ZAR, CSO or CCI back to a plain ISO.
- **info**: `format` (`redump`, `xiso`, `cso`, `cci`, `chd`, `zar`), `xgd` (1, 2, 3 or null for a bare XISO),
  `platform` (`xbox`, `xbox360` or null), `optimized`, `discFormat`, `partitionOffset`, `titleId`, `titleName`.
- **read** (1.3.0+): up to 1 MiB (`length`) of any CHD's decompressed image (CD, DVD, GD-ROM, hard disk) from byte
  `offset`: `{"type":"done","classification":"cd","unitBytes":2448,"imageBytes":...,"offset":...,"length":...,"data":"<base64>"}`.
  A CD's image is its frames of 2448 bytes (2352-byte raw sector, then 96 bytes of subcode); a DVD's its 2048-byte
  sectors. Past the end of the image `data` is shorter (or empty). A CHD that needs a parent is refused. PlayOut reads
  a PS2 / PlayStation / PSP disc's file system through it to find the game's serial (its texture packs).

## Output

stdout carries one JSON object per line, and nothing else:

```
{"type":"progress","phase":"trim","percent":42,"stage":1,"stages":4,"overall":10}
{"type":"progress","phase":"verify","percent":0,"stage":2,"stages":4,"overall":25}
{"type":"done","output":"D:\\Roms\\xbox\\Game.iso","inputBytes":7825141760,"outputBytes":4407296000,"redump":true,"xgd":1,"platform":"xbox",...}
```

or `{"type":"error","message":"..."}` (with `"refused":true` from 1.2.1 when the input itself is refused: not an
Xbox image, damaged, the wrong kind; without it the failure may pass, such as an I/O error). Phases: `trim`, `extract`, `pack`, `zar`, `chd`, `toiso`, `verify` (a verify phase
whose length is unknown stays at 0 until it ends). `stage` / `stages` place the phase among the command's phases
(chd from a full dump: trim, verify, chd, verify) and `overall` is the percent across all of them, never going
back. stderr carries free-form diagnostics only. Exit codes: 0 verified
success (or skipped), 1 failed, 2 usage, 3 cancelled (Ctrl+C).

## Safety

- The source is only read. An output equal to the source is refused, and an existing output is refused without
  `--overwrite`; an output that appears while a run without `--overwrite` works is not replaced either (the run
  fails with "<output> appeared during the conversion" and its partial is deleted).
- Outputs are written as `<name>.playout-partial<ext>` (a folder: `<outDir>.playout-partial`) and renamed into place
  only after verification, so a finished-looking file is always a verified one. A killed process can leave those
  partial names behind; the caller deletes them.
- Verification: trim and toiso (ZAR / CSO / CCI) audit the output and compare every file's path, size and SHA-256
  with the source (`XisoValidator.ValidateConversion`); zar does the same against the image or folder; chd decodes
  every hunk and checks the SHA-1 / MD5 (`Chd.CheckFile`, deep) and compares the file trees; toiso from CHD checks the
  CHD first, then audits and compares the trees; extract maps every source path through XISOSharp's own
  extraction-name resolver (component by component, as the extractor renamed it) and checks the count, size and
  SHA-256 of every file at its mapped path; `renamed` counts the path components that actually changed.
