# pi-edit-file

Block-based, atomic file editing for [Pi](https://pi.dev) agents — one flat patch string instead of nested schemas, with match diagnostics precise enough that the model does not have to re-read the file to trust the result.

```
NNN @@@
old line 1
old line 2
@@@
new line 1
new line 2
@@@
```

## Why

Model-facing edit tooling tends to fail in two ways: the call itself is rejected by an over-complicated schema, or the call "succeeds" into the wrong place. Real numbers from two weeks of Pi sessions (personal setup, 946 edit calls):

| Tool | Calls | Failures | Nature |
|---|---|---|---|
| `quick_edit` | 371 | 4 (1%) | — |
| `target_edit` | 575 | 47 (8.2%) | **all schema validation** |

Every one of those 47 failures was the model mixing up the two tools' schemas — a seven-variant `anyOf` is not something a model navigates reliably. `pi-edit-file` has exactly one shape to get right:

```ts
Type.Object({
  path:  Type.String(),
  patch: Type.String(),   // the whole edit, as text
})
```

The second failure mode was worse than a rejection: a silently misplaced edit. So the tool spends most of its code on **telling the model what actually happened**.

## Install

```bash
pi install git:github.com/acidnik/pi-edit-file
```

Or try it for one run:

```bash
pi -e git:github.com/acidnik/pi-edit-file
```

Loaded from a package, `edit_file` withdraws pi's built-in `edit` tool (same name re-registered with `exposure: "hidden"`), so the model sees a single edit path instead of picking between `edit` and `edit_file` mid-session. Plugin-provided `quick_edit` / `target_edit` are left active as a fallback. If you previously kept it as a plain extension file (`~/.pi/agent/extensions/edit-file.ts`), remove that file first — otherwise the tool gets registered twice.

## Patch format

- `NNN` — 1-based line number where the old block starts. It is an **anchor hint, not a requirement**: the old block itself must be unique (see Matching), and `NNN` only says where you expect it. It may be omitted entirely — start the hunk with a bare `@@@` (an insert still needs `NNN`, since there is no block to match).
- `@@@` — delimiter: 3+ repetitions of one character from `@ # % $ ~ ^ = +`. The character is fixed by the first delimiter and must stay the same for the whole call; escalate to a longer run (`####`) when the file content contains a line like `@@@`.
- A patch that opens with content and holds exactly one delimiter line is read as **one replace hunk** — the leading header was left out, and one delimiter cannot express a chain. Two or more delimiters without headers are still rejected, and the reply rebuilds the blocks with real headers.
- Empty old block → **insert**: `NNN @@@` inserts **before** line `NNN`, `NNN+ @@@` inserts **after** it (append when `NNN` is past the end). Empty new block → **delete**. Otherwise → **replace**. A hunk whose old block equals its new block is a no-op: in a batch it is reported as `SKIPPED`, and a patch made only of no-ops is **rejected** — nothing is written.
- The patch is a JSON string: one patch line is one file line. You never type `\n` yourself — write real line breaks. Backticks, `${...}` and quotes need no escaping.
- A line that *looks* like a hunk header (`NNN` followed by the delimiter — e.g. a line of documentation about this format) starts the next hunk, so it cannot be block content: keep such lines out of a patch, or write them with a leading space and clean up in a second call.
- Lines beginning with `-` or `+` are **ordinary content** — markdown bullets, list continuations, a diff quoted inside a document. They never make a patch invalid; the unified-diff hint only appears in a diagnosis, after such a block failed to match the file (2026-10-07: a bullet plus its `+18…` continuation was rejected as a diff and the whole patch was thrown away).

Several hunks per call, applied atomically:

```
42 @@@
const timeout = 1000
@@@
const timeout = 5000
@@@
120+ @@@
@@@
export const maxRetries = 3
@@@
```

## Matching

Per hunk, against the **original** file content:

1. **exact** block match → 2. lines compared **trimmed** → 3. internal whitespace **collapsed**.
2. Every tier scans the **whole file** — a copy far outside the hint window still counts.
3. The block must match **exactly once**. Several matches → the batch is **rejected** with the candidate lines, whether or not `NNN` points at one of them; proximity never chooses a copy, so extend the block with surrounding lines instead.
4. `NNN` only says where the block is expected: the distance to the matched range (0 when the hint falls inside the block) is reported as `hint N off by K`. Nothing else depends on it — a unique block far from its hint is applied.
5. No hint given → the same uniqueness rule, reported as `unique match (no hint given)`.

Indentation of the file is preserved for matched lines; `CRLF`/`LF` and the presence or absence of a final newline are preserved as well.

## What the model gets back

The first line is the verdict, and it mirrors the rejection line exactly, so "applied and unique" is never confused with "not found / not unique":

```
applied — 2 of 2 hunks, file written
note: hunk 1's hint 20 was off by 49 — the block was found by content and is unique, so the edit was applied at src 69-72.
hunk 1: replace src 69-72 → out 69-73 (4 → 5 lines), exact match, hint 20 off by 49
hunk 2: insert src line 100 → out line 101 (0 → 3 lines), trim match, unique match (no hint given)
src = original file, out = resulting file
file: src/widget.ts — now 205 lines (was 193)
```

A `note:` line sits above the hunk reports when something about the match needs reading before the numbers: a hint that was off (hint and matched `src` lines are both named, and the note says the block was found by content and is unique), and, in a multi-hunk call, the reminder that every hunk was matched against the original numbering — the `out`-numbers are for a follow-up call, never for a later hunk of the same one. The last line may also name a shorter form (`NNN+ @@@`) when an insert was written as a replace.

`[indentation: file indents with tabs, the patch's new lines use spaces]` marks a silent indent-style change (reported, never rewritten). A skipped no-op hunk appears as `SKIPPED — no-op (the old block equals the new block)`; when every hunk is a no-op the call **fails** instead of reporting success.

### A rejected batch says so, and accounts for every hunk

All hunks are resolved against the original before anything is written, so a failure writes nothing — and the error states that explicitly, plus the fate of the hunks that *would* have matched:

```
batch rejected — 0 of 2 hunk(s) applied, nothing was written to the file.
hunk 1: REJECTED — before-block not found (exact, trim and whitespace-collapse matching all failed)
Diagnosis: 2 of 2 before-block line(s) do not exist in the file at all:
  "const nonexistent_block = 42;"
  "const also_missing = true;"
hunk 2: would have matched (replace src lines 4-4, exact) — NOT applied.
```

Without that line, a model reads the failure as "only hunk 1 failed" and walks away believing its second edit landed.

### Failures name the defect

Not-found is the most expensive failure because it is the one models retry blindly. Each case below actually happened, and each now produces its own diagnosis:

| Situation | What the error says |
|---|---|
| Line was deleted earlier in the session | `1 of 1 before-block line(s) do not exist in the file at all: "…"` |
| Block lines exist, wrong order | `every line exists, but NOT in the order written` + actual position of each line |
| Lines exist, not contiguous | `not contiguous — found at lines 41, 57 (expected consecutive lines)` |
| New content written into the old block | `The first 9 line(s) match the file and the trailing 6 do not exist. If those trailing lines are the NEW content …` |
| Unified-diff habit (`-old` / `+new`) | the block is diagnosed **after** it fails to match: *the block mixes N "-" marked line(s) with M "+" marked line(s) — that is a unified diff, not file content* + the shape of a replace patch |
| Typo in one character (`1000` → `1001`) | `closest line 2 (95% similar): "const timeout = 1000;"` |
| Hand-written `\n` inside a line | `Escaping note: a literal "\n" in a before-line is a backslash followed by "n", not a line break …` |
| Block occurs more than once in the file | `not unique — the before-block matches at lines 12, 45 (exact match, 2 copies)` + *include more surrounding lines … a line number cannot choose between identical blocks* |
| Every hunk is a no-op (`before == after`) | `nothing applied — every hunk of this patch is a no-op …, so the file was NOT written` |
| No hunk header at all (chain form), a header where the closing delimiter belongs, or an unterminated hunk | the blocks are located in the file and re-emitted as a ready-to-paste numbered skeleton (`NOT UNIQUE` / `NOT FOUND` placeholders when a block cannot be pinned), with the note that a single unique block may start with a bare delimiter line instead of a number |

Grammar failures get the same treatment as not-found ones: the patch is never applied, and the reply rebuilds the model's own blocks into legal form instead of stopping at a parse error. Not-found failures also include the nearest candidate region with per-line `=` / `≠` markers, and a **ready-to-paste corrected hunk** built from the real file content:

```
Closest candidate: lines 2-4 — 2 of 3 line(s) match.
Actual file content there:
     2 | = function f() {
     3 | ≠   return 42;
     4 | = }

Suggested corrected hunk for hunk 1:
2 @@@
function f() {
  return 42;
}
@@@
function f() {
  return 7;
}
@@@
```

## Rendering

The UI draws the change as a unified diff with word-level highlighting (`details.diff`). The transcript card shows that diff plus a compact `+adds / -removals · N hunks` line — the per-hunk report, the anchor caveats and the shorter-form tip are written for the model and are **not** drawn next to the diff (Nik, 2026-10-01: "только сам дифф"). The model-facing content stays a summary, because models that see raw diffs in tool output start imitating the diff format in their own patches (this happened, and is why the escaping and diff-style diagnostics above exist).
A failed call draws its **error text** instead: a patch rejection carries the whole diagnosis there, and rendering the empty result showed "+0 / -0 · 0 hunks", hiding the reason (2026-10-07).


The same renderer is attached to a `write` override, so overwriting an existing file shows a diff of the old content instead of a bare "Successfully wrote to …".

## Tests

```bash
npm test
```

The suite covers the pure core (parser, matching ladder, atomicity, diagnostics, report caveats, diff generation, CRLF handling) — the count lives in the test output, not here, so it cannot go stale. The core has no Pi imports, so it runs on plain Node ≥ 22.6 with the built-in type stripping.

## License

MIT
