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

Loaded from a package, `edit_file` coexists with whatever editing tools you already have. If you previously kept it as a plain extension file (`~/.pi/agent/extensions/edit-file.ts`), remove that file first — otherwise the tool gets registered twice.

## Patch format

- `NNN` — 1-based line number where the old block starts. It is an **anchor hint, not a requirement**: the nearest match wins. It may be omitted entirely — start the hunk with a bare `@@@` and the block must then match exactly once in the file (an insert still needs `NNN`, since there is no block to match).
- `@@@` — delimiter: 3+ repetitions of one character from `@ # % $ ~ ^ = +`. The character is fixed by the first delimiter and must stay the same for the whole call; escalate to a longer run (`####`) when the file content contains a line like `@@@`.
- Empty old block → **insert** before line `NNN` (append when `NNN` is past the end). Empty new block → **delete**. Otherwise → **replace**.
- The patch is a JSON string: one patch line is one file line. You never type `\n` yourself — write real line breaks. Backticks, `${...}` and quotes need no escaping.

Several hunks per call, applied atomically:

```
42 @@@
const timeout = 1000
@@@
const timeout = 5000
@@@
120 @@@
@@@
export const maxRetries = 3
@@@
```

## Matching

Per hunk, against the **original** file content:

1. **exact** block match → 2. lines compared **trimmed** → 3. internal whitespace **collapsed**.
2. Searched first within ±20 lines of `NNN`, then the whole file.
3. The match nearest to `NNN` wins, where distance is measured **to the matched range** (a hint inside the block means distance 0).
4. Two matches at the same distance → the whole batch is rejected as ambiguous; the candidates are listed.
5. No hint given → the block must be unique; several matches are listed instead of guessed.

Indentation of the file is preserved for matched lines; `CRLF`/`LF` and the presence or absence of a final newline are preserved as well.

## What the model gets back

A successful call reports every hunk with its tier, its real location, and the resulting line numbers (`src` = original file, `out` = resulting file):

```
hunk 1: replace src 69-72 → out 69-73 (4 → 5 lines), exact match, hint 20 off by 49 [LOW CONFIDENCE: matched outside the ±20 line window]
hunk 2: insert src line 100 → out line 101 (0 → 3 lines), trim match, unique match (no hint given)
src = original file, out = resulting file
file: src/widget.ts — now 205 lines (was 193)
```

`[LOW CONFIDENCE: …]` marks a match found outside the hint window; `[also matches at lines 12, 45 — verify the right one]` marks ambiguous snippets that were resolved by proximity; `[indentation: file indents with tabs, the patch's new lines use spaces]` marks a silent indent-style change (reported, never rewritten).

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
| Unified-diff habit (`-old` / `+new`) | `this looks like a unified diff … the patch format needs a "@@@" delimiter between the old and new blocks` |
| Typo in one character (`1000` → `1001`) | `closest line 2 (95% similar): "const timeout = 1000;"` |
| Hand-written `\n` inside a line | `Escaping note: a literal "\n" in a before-line is a backslash followed by "n", not a line break …` |

Not-found failures also include the nearest candidate region with per-line `=` / `≠` markers, and a **ready-to-paste corrected hunk** built from the real file content:

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

The UI draws the change as a unified diff with word-level highlighting (`details.diff`); the model-facing content stays a summary, because models that see raw diffs in tool output start imitating the diff format in their own patches (this happened, and is why the escaping and diff-style diagnostics above exist).

The same renderer is attached to a `write` override, so overwriting an existing file shows a diff of the old content instead of a bare "Successfully wrote to …".

## Tests

```bash
npm test
```

71 tests over the pure core (parser, matching ladder, atomicity, diagnostics, diff generation, CRLF handling). The core has no Pi imports, so it runs on plain Node ≥ 22.6 with the built-in type stripping.

## License

MIT
