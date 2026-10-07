/**
 * Unit tests for edit-file core: parser, resolver ladder, apply, line endings.
 * Run: cd ~/.pi/agent/extensions && tsx --test lib/edit-file-core.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	parsePatch,
	resolveHunks,
	applyHunks,
	runPatch,
	chainSkeleton,
	isNoOpHunk,
	formatHunkReports,
	sequentialDiffs,
	EditError,
	WINDOW,
	unifiedDiff,
	parseUnifiedDiff,
	wordDiffPair,
	patchDelimiter,
	reportCaveats,
	insertTip,
	headerlessSingleHunk,
	appliedLine,
} from "../src/core.ts";

const FILE = [
	"line one",
	"line two",
	"line three",
	"alpha = 1",
	"beta = 2",
	"gamma = 3",
	"line seven",
	"line eight",
].join("\n");

const toLines = (s: string) => s.split("\n");

test("parse: single replace hunk", () => {
	const hunks = parsePatch("3 @@@\nline three\n@@@\nline 3\n@@@");
	assert.equal(hunks.length, 1);
	assert.equal(hunks[0].hint, 3);
	assert.deepEqual(hunks[0].before, ["line three"]);
	assert.deepEqual(hunks[0].after, ["line 3"]);
});

test("parse: multiple hunks, trailing delimiter optional", () => {
	const patch = "1 @@@\nline one\n@@@\nLINE ONE\n@@@\n8 @@@\nline eight\n@@@\nLINE EIGHT";
	const hunks = parsePatch(patch);
	assert.equal(hunks.length, 2);
	assert.deepEqual(hunks[1].before, ["line eight"]);
	assert.deepEqual(hunks[1].after, ["LINE EIGHT"]);
});

test("parse: insert hunk (empty before) and delete hunk (empty after)", () => {
	const hunks = parsePatch("5 @@@\n@@@\nnew line\n@@@\n3 @@@\nline three\n@@@");
	assert.equal(hunks.length, 2);
	assert.deepEqual(hunks[0].before, []);
	assert.deepEqual(hunks[0].after, ["new line"]);
	assert.deepEqual(hunks[1].after, []);
});

test("parse: delimiter escalation to ####", () => {
	const hunks = parsePatch("1 ####\nfoo\n####\nbar\n####");
	assert.deepEqual(hunks[0].before, ["foo"]);
});

test("parse: a foreign-char delimiter run is legal content (exact-run matching)", () => {
	// Delimiter = the EXACT run from the first header; shorter runs and repeats
	// of another character are content (spec v2, §10).
	const hunks = parsePatch("1 @@@\nfoo\n%%%\nbar\n@@@\nfoo2\n%%%\nbar2\n@@@");
	assert.deepEqual(hunks[0].before, ["foo", "%%%", "bar"]);
	assert.deepEqual(hunks[0].after, ["foo2", "%%%", "bar2"]);
});

test("parse: grammar errors", () => {
	assert.throws(() => parsePatch("no header here"), EditError);
	assert.throws(() => parsePatch("1 @@@\nunterminated"), EditError);
	assert.throws(() => parsePatch("1 @@@\n@@@"), EditError); // empty hunk
	assert.throws(() => parsePatch(""), EditError); // no hunks
});

test("parse: @@@ inside a content line is not a delimiter", () => {
	const hunks = parsePatch("1 @@@\nspecial @@@ line\n@@@\nx\n@@@");
	assert.deepEqual(hunks[0].before, ["special @@@ line"]);
});

test("resolve+apply: exact replace near hint", () => {
	const out = runPatch("4 @@@\nalpha = 1\n@@@\nalpha = 10\n@@@", toLines(FILE));
	assert.equal(out.totalLines, 8);
	assert.match(out.diff, /-alpha = 1/);
	assert.match(out.diff, /\+alpha = 10/);
	const applied = applyHunks(toLines(FILE), resolveHunks(parsePatch("4 @@@\nalpha = 1\n@@@\nalpha = 10\n@@@"), toLines(FILE)));
	assert.equal(applied[3], "alpha = 10");
});

test("resolve: trim matching", () => {
	const out = runPatch("4 @@@\n  alpha = 1  \n@@@\nalpha = 10\n@@@", toLines(FILE));
	assert.equal(out.reports[0].kind, "replace");
});

test("resolve: collapse matching (tabs/multiple spaces)", () => {
	const lines = toLines("a\nlet  x\t=\t1\nb");
	const out = runPatch("2 @@@\nlet x = 1\n@@@\nlet x = 2\n@@@", lines);
	assert.equal(out.totalLines, 3);
	assert.equal(applyHunks(lines, resolveHunks(parsePatch("2 @@@\nlet x = 1\n@@@\nlet x = 2\n@@@"), lines))[1], "let x = 2");
});

test("resolve: hint far off still finds whole-file match", () => {
	const out = runPatch("999 @@@\nline eight\n@@@\nLINE EIGHT\n@@@", toLines(FILE));
	assert.equal(out.reports[0].from, 8);
});

test("resolve: a repeated block is rejected even when one copy is closest", () => {
	const lines = toLines("dup\ndup\nmid\ndup\ndup");
	assert.throws(
		() => runPatch("1 @@@\ndup\n@@@\nUNIQ\n@@@", lines),
		/not unique — the before-block matches at lines 1, 2, 4, 5/,
	);
});

test("resolve: the rejection lists every candidate and the tier", () => {
	const lines = toLines("dup\ndup\nmid\ndup\ndup");
	assert.throws(
		() => runPatch("3 @@@\ndup\n@@@\nUNIQ\n@@@", lines),
		/not unique — the before-block matches at lines 1, 2, 4, 5 \(exact match, 4 copies\)/,
	);
});

test("resolve: no match → error with context dump", () => {
	assert.throws(() => runPatch("1 @@@\nno such line\n@@@\nx\n@@@", toLines(FILE)), /Lines around 1/);
});

test("resolve: insert before line NNN, append past EOF", () => {
	const out = runPatch("2 @@@\n@@@\ninserted\n@@@", toLines(FILE));
	assert.equal(out.reports[0].kind, "insert");
	const lines = applyHunks(toLines(FILE), resolveHunks(parsePatch("2 @@@\n@@@\ninserted\n@@@"), toLines(FILE)));
	assert.equal(lines[1], "inserted");
	assert.equal(lines.length, 9);

	const appended = applyHunks(toLines(FILE), resolveHunks(parsePatch("500 @@@\n@@@\ntail\n@@@"), toLines(FILE)));
	assert.equal(appended[appended.length - 1], "tail");
});

test("resolve: delete hunk", () => {
	const out = runPatch("4 @@@\nalpha = 1\n@@@", toLines(FILE));
	assert.equal(out.reports[0].kind, "delete");
	assert.equal(out.totalLines, 7);
});

test("apply: multiple hunks are position-independent (atomic, resolved vs original)", () => {
	const patch = "1 @@@\nline one\n@@@\nLINE ONE\n@@@\n8 @@@\nline eight\n@@@\nLINE EIGHT\n@@@";
	const out = runPatch(patch, toLines(FILE));
	const lines = applyHunks(toLines(FILE), resolveHunks(parsePatch(patch), toLines(FILE)));
	assert.equal(lines[0], "LINE ONE");
	assert.equal(lines[7], "LINE EIGHT");
	assert.equal(out.totalLines, 8);
});

test("apply: overlapping hunks rejected", () => {
	const patch = "1 @@@\nline one\nline two\n@@@\nx\n@@@\n2 @@@\nline two\nline three\n@@@\ny\n@@@";
	assert.throws(() => runPatch(patch, toLines(FILE)), /overlap/);
});

test("apply: delete changes subsequent numbering only after application (bottom-up)", () => {
	const patch = "3 @@@\nline three\n@@@\n@@@\n5 @@@\nbeta = 2\n@@@\nBETA\n@@@";
	const lines = applyHunks(toLines(FILE), resolveHunks(parsePatch(patch), toLines(FILE)));
	assert.equal(lines.length, 7);
	assert.equal(lines[2], "alpha = 1");
	assert.equal(lines[3], "BETA");
});

test("WINDOW is 20 per plan", () => {
	assert.equal(WINDOW, 20);
});

test("hunkDiff: produces unified-style body with context", () => {
	const out = runPatch("4 @@@\nalpha = 1\n@@@\nalpha = 10\n@@@", toLines(FILE));
	// Header covers the context window actually shown in the body (2 lines
	// before/after the hunk), so renderers can map body lines onto the file.
	assert.match(out.diff, /@@ -2,5 \+2,5 @@/);
	assert.match(out.diff, /beta = 2/); // context line
});

test("hunkDiff: header covers context so parsed bStart maps body lines onto the new file", () => {
	// Regression (session 2026-09-28): the header used to be hunk-scoped
	// ("@@ -12,1 +12 @@"), while the body started 2 context lines earlier —
	// renderDiffBody then read the wrong on-disk lines and the displayed edit
	// landed on completely different lines than the one actually edited.
	const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
	const out = runPatch("12 @@@\nline 12\n@@@\nline 12\nline twelve appended\n@@@", lines);
	const parsed = parseUnifiedDiff(out.diff);
	assert.equal(parsed.length, 1);
	// What renderDiffBody reads from disk: the new file content.
	const updated = [...lines.slice(0, 12), "line twelve appended", ...lines.slice(12)];
	// Every context/added line must equal the new file line at its running
	// b-number (bStart comes from the @@ header).
	let b = parsed[0].bStart;
	for (const l of parsed[0].lines) {
		if (l.kind === "-") continue;
		assert.equal(l.text.trim(), updated[b - 1], `b=${b} kind=${l.kind}`);
		b++;
	}
});
test("parse: same-char shorter run is legal content, escalation to a longer run works", () => {
	// Content containing "@@@" is unwritable with an "@@@" delimiter (it splits
	// the block); escalating the whole call to "####" makes "@@@" content.
	const hunks = parsePatch("1 ####\nspecial @@@ line\n####\nspecial @@@ line stays\n####");
	assert.deepEqual(hunks[0].before, ["special @@@ line"]);
	assert.deepEqual(hunks[0].after, ["special @@@ line stays"]);
});
test("sequentialDiffs: context reflects earlier hunks, headers rebased", () => {
	const lines = toLines("a\nold1\nmid\nold2\nz");
	const patch = "2 @@@\nold1\n@@@\nnew1\nextra\n@@@\n4 @@@\nold2\n@@@\nnew2\n@@@";
	const resolved = resolveHunks(parsePatch(patch), lines);
	const parts = sequentialDiffs(lines, resolved);

	// hunk 1: 1→2 lines (net +1)
	assert.match(parts[0], /\+new1\n\+extra/);

	// hunk 2 header rebased by +1 and widened to its context window: in the
	// intermediate state the window (extra, mid, old2, z) starts at line 3
	assert.match(parts[1], /@@ -3,4 \+3,4 @@/);
	// context around hunk 2 shows content created by hunk 1 (extra), not the original
	assert.match(parts[1], /extra/);
	assert.doesNotMatch(parts[1], /new1/); // 2-line context window doesn't reach line 2
	assert.match(parts[1], /\+new2/);
});

test("parse: a diff-style patch without a closing delimiter explains the markers", () => {
	// exactly what glm-5.3-flash wrote in session 2026-09-25: -old lines then +new,
	// with no delimiter at all. Marked lines are no longer a reason to reject a
	// block up front (they can be real content, see the marked-lines tests); the
	// hint rides on the diagnosis that fires for this patch anyway.
	const diffStyle = "56 @@@\n-function saveCheckpoint(doneIds) {\n-  const done = [];\n+// --- checkpoint helpers ---";
	let msg = "";
	try {
		parsePatch(diffStyle);
	} catch (e) {
		msg = (e as Error).message;
	}
	assert.match(msg, /unterminated hunk \(hint 56\) — missing closing "@@@" between the old and new blocks/);
	assert.match(msg, /mixes 2 "-" marked line\(s\) with 1 "\+" marked line\(s\) — that is a unified diff/);
});

test("diagnose: missing line reported as absent (stale before-block)", () => {
	// session 2026-09-26 (npz-bingo): model tried to delete an already-removed key
	const lines = toLines("const ru = {\n\ttitle: 'x',\n\ttabPlants: 'y',\n};\n");
	assert.throws(
		() => runPatch("3 @@@\n\tsubtitle: 'removed earlier',\n@@@\n@@@", lines),
		/1 of 1 before-block line\(s\) do not exist/,
	);
});

test("diagnose: wrong line order reported with actual positions", () => {
	// session 2026-09-26 (npz-bingo): model wrote "version" before "private"; file has the reverse
	const lines = toLines('{\n\t"name": "x",\n\t"private": true,\n\t"version": "0.0.1",\n\t"type": "module",\n\t"scripts": {\n');
	assert.throws(
		() => runPatch('3 @@@\n\t"version": "0.0.1",\n\t"private": true,\n\t"type": "module",\n@@@\n\treplacement\n@@@', lines),
		/every line exists, but NOT in the order written/,
	);
});

test("diagnose: new lines placed in before-block (trailing) suggest moving to after", () => {
	// session 2026-09-26 (npz-bingo AGENTS.md): the model put the new bullet
	// lines in the before-block and left after empty (hunk read as a delete)
	const lines = toLines("## Local dev\n\n- first\n- second\n");
	assert.throws(
		() => runPatch("1 @@@\n## Local dev\n- NEW bullet A\n- NEW bullet B\n@@@\n@@@", lines),
		/belong after the closing delimiter/,
	);
});

test("diagnose: new lines placed first in before-block suggest moving to after", () => {
	const lines = toLines("## Local dev\n\n- first\n- second\n");
	assert.throws(
		() => runPatch("1 @@@\n- NEW bullet A\n## Local dev\n@@@\n@@@", lines),
		/belong after the closing delimiter/,
	);
});

test("diagnose: non-contiguous lines reported with positions", () => {
	const lines = toLines("a\nb\nc\nX\nY\nZ\nd\n");
	assert.throws(
		() => runPatch("1 @@@\nX\nZ\n@@@\nq\n@@@", lines),
		/not contiguous/,
	);
});

test("resolve: diff-style after-block with trailing delimiter gets hint", () => {
	// parse survives (trailing @@@), but before-block contains "+" lines → resolver hints
	const lines = toLines("a\nb\nc");
	assert.throws(
		() => runPatch("2 @@@\n-b\n+new\n@@@", lines),
		/unified diff/,
	);
});

test("batch reject: reports fate of every hunk and states nothing was written", () => {
	const lines = toLines("dup\ndup\nmid\ndup\ndup\nUNIQ TARGET\n");
	let msg = "";
	try {
		runPatch("3 @@@\ndup\n@@@\nUNIQ\n@@@\n6 @@@\nUNIQ TARGET\n@@@\nLAST\n@@@", lines);
	} catch (e) {
		msg = (e as Error).message;
	}
	assert.match(msg, /0 of 2 hunk\(s\) applied, nothing was written/);
	assert.match(msg, /hunk 1: REJECTED — not unique/);
	assert.match(msg, /hunk 2: would have matched .*NOT applied/);
});

test("match info: tier, src range, hint distance", () => {
	const resolved = resolveHunks(parsePatch("1 @@@\nUNIQ TARGET\n@@@\nCHANGED\n@@@"), toLines("a\nb\nUNIQ TARGET\n"));
	assert.equal(resolved[0].match.tier, "exact");
	assert.equal(resolved[0].match.from, 3);
	assert.equal(resolved[0].match.distance, 2);
	assert.equal(resolved[0].match.farFromHint, false);

	const trim = resolveHunks(parsePatch("3 @@@\n   UNIQ TARGET  \n@@@\nCHANGED\n@@@"), toLines("a\nb\nUNIQ TARGET\n"));
	assert.equal(trim[0].match.tier, "trim");
	assert.equal(trim[0].match.distance, 0);
});

test("match info: far-from-hint match is flagged low confidence", () => {
	const lines = toLines(Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\nUNIQ TARGET\n");
	const resolved = resolveHunks(parsePatch("1 @@@\nUNIQ TARGET\n@@@\nCHANGED\n@@@"), lines);
	assert.equal(resolved[0].match.farFromHint, true);
	assert.equal(resolved[0].match.distance, 30);
});

test("formatHunkReports: unambiguous src → out numbering across hunks", () => {
	const lines = toLines("aaa\nbbb\nccc\nddd\neee\nfff\n");
	const patch = "2 @@@\nbbb\n@@@\nB1\nB2\nB3\n@@@\n5 @@@\neee\n@@@\nEEE\n@@@";
	const resolved = resolveHunks(parsePatch(patch), lines);
	const reports = formatHunkReports(resolved);
	assert.match(reports[0], /replace src 2-2 → out 2-4 \(1 → 3 lines\)/);
	// second hunk shifts +2: source line 5 lands on result line 7
	assert.match(reports[1], /replace src 5-5 → out 7-7/);
});

test("not found: suggests a corrected hunk built from the real file content", () => {
	const lines = toLines("## Local dev\n\n- first\n- second\n");
	let msg = "";
	try {
		runPatch("1 @@@\n## Local dev\n- NEW one\n- NEW two\n@@@\n@@@", lines);
	} catch (e) {
		msg = (e as Error).message;
	}
	assert.match(msg, /Closest candidate: lines 1-3 — 1 of 3 line\(s\) match/);
	assert.match(msg, /Suggested corrected hunk for hunk 1:/);
	assert.match(msg, /- NEW one/);
	assert.match(msg, /belong after the closing delimiter/);
});

test("not found: missing line suggestion keeps the model's after-block", () => {
	const lines = toLines("a\nb\nc\n");
	let msg = "";
	try {
		// "a", "X": X does not exist → close candidate is lines 1-2, after-block reused
		runPatch("1 @@@\na\nX\n@@@\nA2\nB2\n@@@", lines);
	} catch (e) {
		msg = (e as Error).message;
	}
	assert.match(msg, /Closest candidate: lines 1-2/);
	assert.match(msg, /Suggested corrected hunk/);
	assert.match(msg, /A2/);
	assert.match(msg, /B2/);
});

test("not unique: a repeated block is rejected even when the hint is nearest", () => {
	const lines = toLines("dup\ndup\nmid\ndup\ndup\n");
	// hint 2 is nearest to the copy at line 2, but the snippet also sits at 1, 4, 5:
	// proximity never picks a copy (2026-10-02 — "not unique" is an error).
	assert.throws(
		() => resolveHunks(parsePatch("2 @@@\ndup\n@@@\nUNIQ\n@@@"), lines),
		/not unique — the before-block matches at lines 1, 2, 4, 5 \(exact match, 4 copies\)/,
	);
});

test("not unique: a copy outside the hint window still blocks the edit", () => {
	// the second copy is 46 lines past the hint: the search is file-wide, so the
	// hint window cannot hide it.
	const rows = Array.from({ length: 60 }, (_, i) => (i === 4 || i === 50 ? "TARGET" : `line ${i + 1}`));
	assert.throws(
		() => resolveHunks(parsePatch(`5 @@@\nTARGET\n${D}\nX\n${D}`), toLines(rows.join("\n"))),
		/not unique — the before-block matches at lines 5, 51/,
	);
});

test("match info: a unique match reports no alternatives and no warning", () => {
	const resolved = resolveHunks(parsePatch("2 @@@\nbbb\n@@@\nB\n@@@"), toLines("aaa\nbbb\nccc\n"));
	const report = formatHunkReports(resolved)[0];
	assert.match(report, /exact match/);
	assert.doesNotMatch(report, /also matches|LOW CONFIDENCE/);
});

test("ambiguity: identical blocks are a hard error whatever the hint says", () => {
	// two byte-identical blocks flanking the hint (one line away from each)
	const lines = toLines("a\n.name {\n\tflex: 1;\n}\nb\n.name {\n\tflex: 1;\n}\n");
	assert.throws(
		() => runPatch("5 @@@\n.name {\n\tflex: 1;\n}\n@@@\n.name {\n\tflex: 9;\n}\n@@@", lines),
		/not unique — the before-block matches at lines 2, 6 \(exact match, 2 copies\)/,
	);
});

test("distance is measured to the block range, not its first line", () => {
	const lines = toLines("a\nb\nTARGET\nc\nd\n");
	// hint inside the block → distance 0
	const inside = resolveHunks(parsePatch("3 @@@\nTARGET\n@@@\nX\n@@@"), lines);
	assert.equal(inside[0].match.distance, 0);
	// hint one line below the block → distance 1 (not |start - hint| = 1 either, but explicit)
	const below = resolveHunks(parsePatch("4 @@@\nTARGET\n@@@\nX\n@@@"), lines);
	assert.equal(below[0].match.distance, 1);
	// hint far below a 3-line block: distance measured from the block's last line
	const far = runPatch("5 @@@\nTARGET\n@@@\nX\n@@@", lines);
	assert.equal(far.lines[0].includes("hint 5 off by 2"), true);
});

test("indent mismatch between file (tabs) and patch (spaces) is reported", () => {
	const lines = toLines(".name {\n\theight: 60%;\n}\n");
	const resolved = resolveHunks(parsePatch("2 @@@\n    height: 60%;\n@@@\n    height: 70%;\n@@@"), lines);
	assert.equal(resolved[0].match.tier, "trim");
	assert.match(resolved[0].match.indentMismatch ?? "", /file indents with tabs, the patch's new lines use spaces/);
	assert.match(formatHunkReports(resolved)[0], /\[indentation: file indents with tabs/);
});

test("indent note is not raised for a top-level-only block (no indented lines)", () => {
	const lines = toLines("function f() {\n\treturn 1;\n}\n");
	// after-block has no indented lines → nothing to compare
	const resolved = resolveHunks(parsePatch("1 @@@\nfunction f() {\n@@@\nfunction g() {\n@@@"), lines);
	assert.equal(resolved[0].match.indentMismatch, undefined);
});

test("indent note is judged against the whole file, not the matched block", () => {
	// file is tab-indented everywhere; the matched block happens to be top-level
	const lines = toLines("export function a() {\n\treturn 1;\n}\n\nconst top = 1;\n\tconst b = 2;\n");
	const resolved = resolveHunks(parsePatch("5 @@@\nconst top = 1;\n@@@\nconst top = 9;\n@@@"), lines);
	assert.equal(resolved[0].match.indentMismatch, undefined); // patch line is not indented at all
});

test("no indent note when styles agree", () => {
	const lines = toLines(".name {\n\theight: 60%;\n}\n");
	const resolved = resolveHunks(parsePatch("2 @@@\nheight: 60%;\n@@@\n\theight: 70%;\n@@@"), lines);
	assert.equal(resolved[0].match.indentMismatch, undefined);
});

test("not found: typo-level near miss names the closest real line", () => {
	const lines = toLines("head\nconst timeout = 1000;\ntail");
	let msg = "";
	try {
		runPatch("2 @@@\nconst timeout = 1001;\n@@@\nconst timeout = 5000;\n@@@", lines);
	} catch (e) {
		msg = (e as Error).message;
	}
	assert.match(msg, /Did you mean one of these\?/);
	assert.match(msg, /closest line 2 \(9\d% similar\): "const timeout = 1000;"/);
});

test("not found: no typo hint when nothing is similar enough", () => {
	const lines = toLines("alpha\nbeta\ngamma");
	let msg = "";
	try {
		runPatch("2 @@@\ncompletely different line here\n@@@\nX\n@@@", lines);
	} catch (e) {
		msg = (e as Error).message;
	}
	assert.doesNotMatch(msg, /Did you mean one of these\?/);
});

// ---------------------------------------------------------------------------
// unifiedDiff — used by the write override to show whole-file overwrites
// ---------------------------------------------------------------------------

test("unifiedDiff: identical texts produce no diff", () => {
	assert.equal(unifiedDiff("a\nb\n", "a\nb\n", "f.txt"), "");
});

test("unifiedDiff: single-line change keeps context and correct hunk header", () => {
	const diff = unifiedDiff("a\nb\nc\nd\ne\n", "a\nb\nX\nd\ne\n", "f.txt");
	assert.match(diff, /^--- a\/f\.txt\n\+\+\+ b\/f\.txt\n/);
	assert.match(diff, /@@ -1,5 \+1,5 @@/);
	assert.match(diff, /^-c$/m);
	assert.match(diff, /^\+X$/m);
	assert.match(diff, /^ a$/m); // context preserved
});

test("unifiedDiff: insertion in the middle", () => {
	const diff = unifiedDiff("a\nb\nc\n", "a\nb\nNEW\nc\n", "f.txt");
	assert.match(diff, /^\+NEW$/m);
	assert.match(diff, /@@ -1,3 \+1,4 @@/);
});

test("unifiedDiff: deletion", () => {
	const diff = unifiedDiff("a\nb\nc\n", "a\nc\n", "f.txt");
	assert.match(diff, /^-b$/m);
	assert.match(diff, /@@ -1,3 \+1,2 @@/);
});

test("unifiedDiff: separated changes produce two hunks with no shared context", () => {
	const oldText = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") + "\n";
	const lines = oldText.trimEnd().split("\n");
	lines[0] = "CHANGED 0";
	lines[39] = "CHANGED 39";
	const diff = unifiedDiff(oldText, lines.join("\n") + "\n", "f.txt");
	const hunks = diff.split("\n").filter((l) => l.startsWith("@@"));
	assert.equal(hunks.length, 2);
});

test("unifiedDiff: full rewrite of a short file is one hunk", () => {
	const diff = unifiedDiff("x\ny\n", "1\n2\n3\n", "f.txt");
	assert.match(diff, /^-x$/m);
	assert.match(diff, /^-y$/m);
	assert.match(diff, /^\+1$/m);
	assert.match(diff, /^\+3$/m);
});

test("unifiedDiff: no-newline-at-eof difference still diffs", () => {
	const diff = unifiedDiff("a\nb\n", "a\nb", "f.txt");
	assert.match(diff, /^@@ /m);
});

test("unifiedDiff: huge middle degrades to one block instead of a giant LCS table", () => {
	const oldText = Array.from({ length: 1200 }, (_, i) => `old ${i}`).join("\n");
	const newText = Array.from({ length: 1200 }, (_, i) => `new ${i}`).join("\n");
	const diff = unifiedDiff(oldText, newText, "big.txt");
	assert.match(diff, /^@@ -1,1200 \+1,1200 @@/m);
	assert.equal(diff.split("\n").filter((l) => l.startsWith("-old ")).length, 1200);
	assert.equal(diff.split("\n").filter((l) => l.startsWith("+new ")).length, 1200);
});

test("unifiedDiff: absolute path is not rendered with a double slash", () => {
	const diff = unifiedDiff("a\n", "b\n", "/tmp/x.txt");
	assert.match(diff, /^--- \/tmp\/x\.txt$/m);
	assert.doesNotMatch(diff, /a\/\//);
});

test("unifiedDiff: relative path keeps git-style a/ b/ labels", () => {
	const diff = unifiedDiff("a\n", "b\n", "src/x.ts");
	assert.match(diff, /^--- a\/src\/x\.ts$/m);
	assert.match(diff, /^\+\+\+ b\/src\/x\.ts$/m);
});

// ---------------------------------------------------------------------------
// parseUnifiedDiff / wordDiffPair — syntax-highlighted diff rendering
// ---------------------------------------------------------------------------

test("parseUnifiedDiff: skips file headers, keeps hunk meta and line kinds", () => {
	const diff = unifiedDiff("a\nb\nc\n", "a\nB\nc\n", "f.ts");
	const hunks = parseUnifiedDiff(diff);
	assert.equal(hunks.length, 1);
	assert.equal(hunks[0].bStart, 1);
	assert.deepEqual(hunks[0].lines.map((l) => l.kind), [" ", "-", "+", " "]);
	assert.deepEqual(hunks[0].lines.map((l) => l.text), ["a", "b", "B", "c"]);
});

test("parseUnifiedDiff: two hunks keep their own new-file start lines", () => {
	const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
	const edited = [...lines];
	edited[0] = "CHANGED 0";
	edited[39] = "CHANGED 39";
	const hunks = parseUnifiedDiff(unifiedDiff(lines.join("\n") + "\n", edited.join("\n") + "\n", "f.txt"));
	assert.equal(hunks.length, 2);
	assert.equal(hunks[0].bStart, 1);
	assert.equal(hunks[1].bStart, 37); // line 40 minus 3 lines of context
});

test("parseUnifiedDiff: ignores no-newline markers", () => {
	const diff = unifiedDiff("a\nb\n", "a\nb", "f.txt");
	const hunks = parseUnifiedDiff(diff);
	assert.equal(hunks.length, 1);
	assert.ok(hunks[0].lines.every((l) => !l.text.startsWith("\\")));
});

test("parseUnifiedDiff: empty input yields no hunks", () => {
	assert.deepEqual(parseUnifiedDiff(""), []);
	assert.deepEqual(parseUnifiedDiff("--- a/x\n+++ b/x\n"), []);
});

test("wordDiffPair: identical lines are one unchanged segment", () => {
	const p = wordDiffPair("const x = 1;", "const x = 1;");
	assert.deepEqual(p.old, [{ text: "const x = 1;", changed: false }]);
	assert.deepEqual(p.new, [{ text: "const x = 1;", changed: false }]);
});

test("wordDiffPair: marks only the edited token", () => {
	const p = wordDiffPair("RETRIES = 3;", "RETRIES = 5;");
	assert.equal(p.old.map((s) => s.text).join(""), "RETRIES = 3;");
	assert.equal(p.new.map((s) => s.text).join(""), "RETRIES = 5;");
	assert.deepEqual(p.old.filter((s) => s.changed).map((s) => s.text), ["3"]);
	assert.deepEqual(p.new.filter((s) => s.changed).map((s) => s.text), ["5"]);
});

test("wordDiffPair: segments always concatenate back to the input", () => {
	for (const [a, b] of [
		["", ""],
		["a", ""],
		["", "b"],
		["function greet(x) {", "function greet(x, y) {"],
		["\treturn `hi ${n}`;", "\treturn `hi ${n}!`;"],
		["same", "totally different text here"],
	]) {
		const p = wordDiffPair(a, b);
		assert.equal(p.old.map((s) => s.text).join(""), a);
		assert.equal(p.new.map((s) => s.text).join(""), b);
	}
});

test("hintless: bare @@@ header works when the block is unique", () => {
	const hunks = parsePatch("@@@\nconst timeout = 1000;\n@@@\nconst timeout = 5000;\n@@@");
	assert.equal(hunks.length, 1);
	assert.equal(hunks[0].hint, null);
	const out = runPatch("@@@\nconst timeout = 1000;\n@@@\nconst timeout = 5000;\n@@@", toLines("a\nconst timeout = 1000;\nb"));
	assert.match(out.lines[0], /replace src 2-2 → out 2-2 \(1 → 1 lines\), exact match, unique match \(no hint given\)/);
});

test("hintless: two matching blocks are rejected with an explanation", () => {
	const lines = toLines("a\n.name {\n\tflex: 1;\n}\nb\n.name {\n\tflex: 1;\n}\n");
	let msg = "";
	try {
		runPatch("@@@\n.name {\n\tflex: 1;\n}\n@@@\n.name {\n\tflex: 9;\n}\n@@@", lines);
	} catch (e) {
		msg = (e as Error).message;
	}
	assert.match(msg, /not unique — the before-block matches at lines 2, 6 \(exact match, 2 copies\)/);
	assert.match(msg, /Include more surrounding lines in the before-block so it matches exactly once/);
});

test("hintless: an insert without NNN is rejected with an explanation", () => {
	let msg = "";
	try {
		runPatch("@@@\n@@@\nnew line\n@@@", toLines("a\nb"));
	} catch (e) {
		msg = (e as Error).message;
	}
	assert.match(msg, /an insert has no block to match/);
});

test("hintless: two hintless hunks in one patch, trailing terminator omitted", () => {
	const patch = "@@@\naaa\n@@@\nAAA\n@@@\nccc\n@@@\nCCC\n@@@";
	const hunks = parsePatch(patch);
	assert.equal(hunks.length, 2);
	assert.deepEqual(
		hunks.map((h) => h.before),
		[["aaa"], ["ccc"]],
	);
	const out = runPatch(patch, toLines("aaa\nbbb\nccc"));
	assert.equal(out.totalLines, 3);
});

test("hintless: hint and hintless hunks mix in one patch", () => {
	const patch = "1 @@@\naaa\n@@@\nAAA\n@@@\n@@@\nccc\n@@@\nCCC\n@@@";
	const hunks = parsePatch(patch);
	assert.deepEqual(
		hunks.map((h) => h.hint),
		[1, null],
	);
	const out = runPatch(patch, toLines("aaa\nbbb\nccc"));
	assert.equal(out.totalLines, 3);
});

test("escaping: a literal backslash-n in the before-block is explained", () => {
	const lines = toLines("aaa\nbbb\nccc");
	let msg = "";
	try {
		runPatch("2 @@@\naaa\\nbbb\n@@@\nX\n@@@", lines);
	} catch (e) {
		msg = (e as Error).message;
	}
	assert.match(msg, /Escaping note: a literal "\\n" in a before-line/);
	assert.match(msg, /write each file line on its own patch line/);
});

test("escaping: no note when the backslash-n is genuine file content", () => {
	// the file really contains a Python-style "\n" inside a string; expanding it
	// does NOT reproduce file lines, so no advice is given
	const lines = toLines('msg = "line1\\nline2"\nother');
	let msg = "";
	try {
		runPatch('2 @@@\nmsg = "line1\\nline2"\n@@@\nmsg = "x"\n@@@', lines);
	} catch (e) {
		msg = (e as Error).message;
	}
	assert.doesNotMatch(msg, /Escaping note/);
});

test("suggestCorrection: typo-level near miss still yields a pasteable hunk", () => {
	const lines = toLines("head\nexport const TIMEOUT_MS = 30_000;\ntail");
	let msg = "";
	try {
		runPatch("2 @@@\nexport const TIMEOUT_MS = 31_000;\n@@@\nexport const TIMEOUT_MS = 60_000;\n@@@", lines);
	} catch (e) {
		msg = (e as Error).message;
	}
	assert.match(msg, /closest line 2 \(\d+% similar\): "export const TIMEOUT_MS = 30_000;"/);
	assert.match(msg, /Suggested corrected hunk for hunk 1:/);
	assert.match(msg, /2 @@@\nexport const TIMEOUT_MS = 30_000;\n@@@\nexport const TIMEOUT_MS = 60_000;\n@@@/);
});

test("indent note: JSDoc continuation lines do not count as space indentation", () => {
	// a tab-indented file whose block is preceded by / followed by a JSDoc comment
	const lines = toLines("/**\n * doc line\n */\nconst A = 1;\n");
	const resolved = resolveHunks(parsePatch("4 @@@\nconst A = 1;\n@@@\nconst A = 2;\n@@@"), lines);
	assert.equal(resolved[0].match.indentMismatch, undefined);

	// the patch itself is a JSDoc block being rewritten: no note either
	const doc = toLines("/**\n * old doc\n */\nconst A = 1;\n");
	const patch = "1 @@@\n/**\n * old doc\n */\n@@@\n/**\n * new doc\n */\n@@@";
	assert.equal(resolveHunks(parsePatch(patch), doc)[0].match.indentMismatch, undefined);
});
// ---------------------------------------------------------------------------
// Spec v2: chain skeleton, NNN+ insert-after, no-op hunks, artifacts
// ---------------------------------------------------------------------------

const D = "@@@";

test("chain: even chain yields a numbered skeleton, no auto-apply", () => {
	const file = toLines("a\nb\nc\nd\ne\nf\ng");
	const patch = `b\n${D}\nB\n${D}\ne\n${D}\nE\n${D}`;
	const sk = chainSkeleton(patch, file);
	assert.match(sk, /chain form/);
	assert.match(sk, /2 @@@/);        // b sits at line 2
	assert.match(sk, /5 @@@/);        // e sits at line 5
	assert.match(sk, /your before block: 1 line . it sits at src 2-2/);
	assert.match(sk, /Rules:/);
	assert.equal(file.join("\n"), "a\nb\nc\nd\ne\nf\ng"); // file untouched
});

test("chain: ambiguous before-block lists ALL candidates, no auto-pick", () => {
	const file = toLines("same\nsame\nx\nsame\nsame");
	const sk = chainSkeleton(`same\n${D}\nnew\n${D}`, file);
	assert.match(sk, /NOT UNIQUE/);
	assert.match(sk, /matches at lines 1, 2, 4, 5/);
	assert.doesNotMatch(sk, /2 @@@/); // no number chosen for the model
});

test("chain: missing block reports NOT FOUND", () => {
	const sk = chainSkeleton(`nope\n${D}\nnew\n${D}`, toLines("a\nb\nc"));
	assert.match(sk, /NOT FOUND/);
});

test("chain: trim-unique block gets a number with a whitespace note", () => {
	const file = toLines("  spaced line\nx");
	const sk = chainSkeleton(`spaced line\n${D}\nnew\n${D}`, file);
	assert.match(sk, /1 @@@/);
	assert.match(sk, /matched with whitespace differences/);
});

test("chain: odd tail gets the delete-or-append hint", () => {
	const file = toLines("a\nb\nc");
	const sk = chainSkeleton(`b\n${D}\nB\n${D}\nc`, file);
	assert.match(sk, /the patch ends here/);
	assert.match(sk, /DELETE this block/);
});

test("chain: patch without any delimiter gets the no-delimiter error", () => {
	const sk = chainSkeleton("just some content\nmore content", toLines("a"));
	assert.match(sk, /no "@@@" delimiter found/);
});

test("chain: explicit headers inside a chain keep their numbers", () => {
	const file = toLines("a\nb\nc\nd");
	const sk = chainSkeleton(`3 @@@\nc\n${D}\nC\n${D}`, file);
	assert.match(sk, /3 @@@/);
	assert.match(sk, /src 3-3/);
});

test("parse: NNN@@@ without a space is a header", () => {
	const hunks = parsePatch(`2@@@\nb\n${D}\nB\n${D}`);
	assert.equal(hunks[0].hint, 2);
	assert.deepEqual(hunks[0].before, ["b"]);
});

test("insert-after (NNN+): before a middle line vs after it", () => {
	const file = toLines("a\nb\nc");
	const beforeHunk = resolveHunks(parsePatch(`2 @@@\n@@@\nNEW\n${D}`), file);
	const afterHunk = resolveHunks(parsePatch(`2+ @@@\n@@@\nNEW\n${D}`), file);
	assert.equal(beforeHunk[0].start, 1); // before line 2 → index 1
	assert.equal(afterHunk[0].start, 2);  // after line 2 → index 2
	assert.equal(applyHunks(file, afterHunk).join("\n"), "a\nb\nNEW\nc");
});

test("insert-after (NNN+): after the last line appends", () => {
	const file = toLines("a\nb");
	const resolved = resolveHunks(parsePatch(`2+ @@@\n@@@\nNEW\n${D}`), file);
	assert.equal(applyHunks(file, resolved).join("\n"), "a\nb\nNEW");
});

test("insert-after (NNN+): rejected on replace and zero headers", () => {
	assert.throws(() => parsePatch(`1+ @@@\na\n${D}\nA\n${D}`), /only valid for inserts/);
	assert.throws(() => parsePatch(`0+ @@@\n@@@\nNEW\n${D}`), /needs NNN >= 1/);
});

test("parse: trailing blank lines of an EOF-closed after-block are dropped", () => {
	const hunks = parsePatch(`1 @@@\na\n${D}\nA\n\n\n`);
	assert.deepEqual(hunks[0].after, ["A"]);
	// ...but blanks before an explicit terminator are content
	const explicit = parsePatch(`1 @@@\na\n${D}\nA\n\n${D}`);
	assert.deepEqual(explicit[0].after, ["A", ""]);
});

test("no-op: exact before==after is reported as skipped", () => {
	assert.equal(isNoOpHunk({ hint: 1, before: ["a", "b"], after: ["a", "b"] }), true);
	assert.equal(isNoOpHunk({ hint: 1, before: ["a"], after: ["a "] }), false); // trim-diff applies
	assert.equal(isNoOpHunk({ hint: 1, before: [], after: ["new"] }), false);    // insert
});

test("report: insert direction is spelled out (BEFORE/AFTER)", () => {
	const file = toLines("a\nb\nc");
	const beforeRep = formatHunkReports(resolveHunks(parsePatch(`2 @@@\n@@@\nNEW\n${D}`), file));
	const afterRep = formatHunkReports(resolveHunks(parsePatch(`2+ @@@\n@@@\nNEW\n${D}`), file));
	assert.match(beforeRep[0], /insert BEFORE src line 2/);
	assert.match(afterRep[0], /insert AFTER src line 2/);
});

test("report: original hunk numbers survive no-op filtering", () => {
	const out = formatHunkReports(
		resolveHunks([parsePatch(`1 @@@\na\n${D}\nA\n${D}`)[0]], toLines("a\nb")),
		[1], // 0-based original index: this active hunk was hunk 2 in the patch
	);
	assert.match(out[0], /hunk 2:/);
});

// ---------------------------------------------------------------------------
// Feedback 2026-10-01: grammar discoverability, stale anchors, insert tip
// ---------------------------------------------------------------------------

test("parse: delimiter-missing errors carry codes for the skeleton path", () => {
	const missing = `1 @@@\na\n3 @@@\nb\n${D}`;
	assert.throws(() => parsePatch(missing), (e: unknown) => (e as EditError).code === "missing-separator");
	const unterminated = `1 @@@\na\nb`;
	assert.throws(() => parsePatch(unterminated), (e: unknown) => (e as EditError).code === "unterminated");
	// `missing` still has one full-line run, so the skeleton can split the blocks
	// and is built; `unterminated` has only a header-style delimiter, and there
	// the extension keeps the precise diagnosis (grammarError guard in
	// src/extension.ts) instead of the skeleton's "no delimiter found" fallback.
	assert.equal(patchDelimiter(missing), "@@@");
	assert.equal(patchDelimiter(unterminated), null);
	assert.equal(patchDelimiter(`1 @@@\na\n@@@\nb\n@@@`), "@@@");
});

test("report: the applied line mirrors the rejection line", () => {
	assert.equal(appliedLine(2, 2), "applied — 2 of 2 hunks, file written");
	assert.equal(appliedLine(1, 1), "applied — 1 of 1 hunk, file written");
	// a no-op hunk was skipped: applied < total is the loud part
	assert.equal(appliedLine(1, 3), "applied — 1 of 3 hunks, file written");
});

test("delimiter: patchDelimiter returns the call's run", () => {
	assert.equal(patchDelimiter(`2 @@@\na\n@@@\nA\n@@@`), "@@@");
	assert.equal(patchDelimiter(`2 ####\na\n####\nA\n####`), "####");
	assert.equal(patchDelimiter("no delimiters here"), null);
});

test("chain: preamble teaches that a single block needs no number", () => {
	const sk = chainSkeleton(`b\n${D}\nB\n${D}`, toLines("a\nb\nc"));
	assert.match(sk, /chain form/);
	assert.match(sk, /A block that occurs exactly once in the file needs no number/);
	assert.match(sk, new RegExp(`bare "${D}" line`));
});

test("caveats: exact-hint and distance-0 matches are silent", () => {
	const file = toLines("a\nb\nc");
	assert.deepEqual(reportCaveats(resolveHunks(parsePatch(`2 @@@\nb\n${D}\nB\n${D}`), file)), []);
	assert.deepEqual(reportCaveats(resolveHunks(parsePatch(`2 @@@\n@@@\nNEW\n${D}`), file)), []);
});

test("caveats: an off-by hint is reported as a fact, not as a warning", () => {
	const file = toLines("a\nb\nc\nd\ne");
	const caveats = reportCaveats(resolveHunks(parsePatch(`5 @@@\nb\nc\n${D}\nB\nC\n${D}`), file));
	assert.equal(caveats.length, 1);
	assert.match(caveats[0], /hunk 1's hint 5 was off by 2 — the block was found by content and is unique, so the edit was applied at src 2-3\./);
	assert.doesNotMatch(caveats[0], /verify|confidence|±20/i);
});

test("caveats: a unique block far from its hint is applied and stated plainly", () => {
	const file = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
	const resolved = resolveHunks(parsePatch(`1 @@@\nline 35\n${D}\nX\n${D}`), file);
	assert.equal(resolved[0].match.farFromHint, true); // kept as data, never as a warning
	assert.match(reportCaveats(resolved)[0], /hint 1 was off by 34 — the block was found by content and is unique, so the edit was applied at src 35-35\./);
	const line = formatHunkReports(resolved)[0];
	assert.match(line, /hint 1 off by 34/);
	assert.doesNotMatch(line, /LOW CONFIDENCE/);
});

test("caveats: a multi-hunk call gets the original-numbering note", () => {
	const file = toLines("a\nb\nc\nd\ne");
	const resolved = resolveHunks(parsePatch(`1 @@@\na\n${D}\nA\n${D}\n4 @@@\nd\n${D}\nD\n${D}`), file);
	assert.equal(resolved.length, 2);
	const caveats = reportCaveats(resolved);
	assert.equal(caveats.length, 1);
	assert.match(caveats[0], /every hunk of one call matches the ORIGINAL file numbering/);
});

test("caveats: restored hunk numbers are used in the note", () => {
	const file = toLines("a\nb\nc\nd\ne");
	const caveats = reportCaveats(resolveHunks(parsePatch(`5 @@@\nb\nc\n${D}\nB\nC\n${D}`), file), [1]);
	assert.match(caveats[0], /hunk 2's hint/);
});

test("tip: an append written as a replace points at NNN+", () => {
	const file = toLines("function f() {\n\treturn 1;\n}");
	const resolved = resolveHunks(parsePatch(`1 @@@\nfunction f() {\n${D}\nfunction f() {\n\tconst x = 1;\n${D}`), file);
	const tip = insertTip(resolved);
	assert.match(tip ?? "", /only adds 1 line AFTER src line 1/);
	assert.match(tip ?? "", /"1\+ @@@"/);
	assert.match(tip ?? "", /without repeating the old block/);
});

test("tip: a prepend written as a replace points at insert-before", () => {
	const file = toLines("a\ntarget\nc");
	const resolved = resolveHunks(parsePatch(`2 @@@\ntarget\n${D}\nnew line\ntarget\n${D}`), file);
	const tip = insertTip(resolved);
	assert.match(tip ?? "", /only adds 1 line BEFORE src line 2/);
	assert.match(tip ?? "", /"2 @@@"/);
});

test("tip: a real rewrite and a plain insert get no tip", () => {
	const file = toLines("a\nb\nc");
	assert.equal(insertTip(resolveHunks(parsePatch(`2 @@@\nb\n${D}\nB2\n${D}`), file)), null);
	assert.equal(insertTip(resolveHunks(parsePatch(`2 @@@\n@@@\nNEW\n${D}`), file)), null);
});

test("tip: the call's own delimiter is used in the advice", () => {
	const file = toLines("a\nb\nc");
	const resolved = resolveHunks(parsePatch(`2 ####\nb\n####\nb\nnew line\n####`), file);
	assert.match(insertTip(resolved, undefined, "####") ?? "", /"2\+ ####"/);
});

// ---------------------------------------------------------------------------
// Headerless single hunk: content, one delimiter, content (2026-10-02 feedback)
// ---------------------------------------------------------------------------

test("headerless: content + one delimiter is a single replace hunk", () => {
	const patch = `    indented A\n    indented B\n${D}\n    indented A\n    indented B (edited)`;
	const hunks = parsePatch(patch);
	assert.equal(hunks.length, 1);
	assert.equal(hunks[0].hint, null);
	assert.deepEqual(hunks[0].before, ["    indented A", "    indented B"]);
	assert.deepEqual(hunks[0].after, ["    indented A", "    indented B (edited)"]);
	assert.equal(hunks[0].leadingDelimiterOmitted, true);
});

test("headerless: the edit applies, reported as a unique hintless match", () => {
	const file = toLines("    indented A\n    indented B\n    indented C\n    tail");
	const patch = `    indented A\n    indented B\n${D}\n    indented A\n    indented B (edited)`;
	const resolved = resolveHunks(parsePatch(patch), file);
	assert.equal(applyHunks(file, resolved).join("\n"), "    indented A\n    indented B (edited)\n    indented C\n    tail");
	assert.match(formatHunkReports(resolved)[0], /replace src 1-2 → out 1-2 \(2 → 2 lines\), exact match, unique match \(no hint given\)/);
});

test("headerless: empty new block deletes, and the nudge is reported", () => {
	const file = toLines("a\nb\nc");
	const resolved = resolveHunks(parsePatch(`a\nb\n${D}\n`), file);
	assert.equal(applyHunks(file, resolved).join("\n"), "c");
	assert.match(reportCaveats(resolved).join("\n"), /the patch had no leading hunk header/);
});

test("headerless: the canonical bare form gets no nudge", () => {
	const file = toLines("a\nb\nc");
	assert.deepEqual(reportCaveats(resolveHunks(parsePatch(`${D}\na\nb\n${D}\nc\n${D}`), file)), []);
});

test("headerless: an ambiguous block is still rejected, never auto-picked", () => {
	const file = toLines("same\nsame\nx\nsame\nsame");
	assert.throws(() => resolveHunks(parsePatch(`same\n${D}\nnew`), file), /not unique — the before-block matches at lines/);
});

test("headerless: the helper stays out when the reading is not unambiguous", () => {
	assert.equal(headerlessSingleHunk("just content\nmore content"), null); // no delimiter
	assert.equal(headerlessSingleHunk(`b\n${D}\nB\n${D}`), null);           // two delimiters
	assert.equal(headerlessSingleHunk(`${D}\nb\n${D}\nB\n${D}`), null);     // leading bare delimiter: already legal
	assert.equal(headerlessSingleHunk(`b\n2 ${D}\nB`), null);               // numbered header present
	assert.equal(headerlessSingleHunk(`   \n${D}\nnew`), null);             // nothing to anchor on
});

test("chain: the rejection no longer claims a block count it cannot know", () => {
	const sk = chainSkeleton(`b\n${D}\nB\n${D}`, toLines("a\nb\nc"));
	assert.match(sk, /the patch opens with content instead of a hunk header/);
	assert.doesNotMatch(sk, /two or more blocks/);
});

// ---------------------------------------------------------------------------
// Marked lines are content, not a diff (jup-degen session, 2026-10-07)
// ---------------------------------------------------------------------------

test("marked lines: a '-' bullet with a '+' continuation line is applied", () => {
	// The exact shape that was rejected as a unified diff: a markdown bullet and
	// its continuation line starting with "+18…".
	const file = toLines("keep\n- полоса 50-60 cents:\n  +18…+22 cents on 77-97 quotes;\ntail");
	const patch = `@@@\n- полоса 50-60 cents:\n  +18…+22 cents on 77-97 quotes;\n@@@\n- полоса 50-60 cents:\n  +18…+24 cents on 77-97 quotes;\n@@@`;
	const resolved = resolveHunks(parsePatch(patch), file);
	assert.equal(
		applyHunks(file, resolved).join("\n"),
		"keep\n- полоса 50-60 cents:\n  +18…+24 cents on 77-97 quotes;\ntail",
	);
});

test("marked lines: parsing never rejects them up front", () => {
	const hunks = parsePatch("@@@\n- old line\n+ new line\n@@@");
	assert.equal(hunks.length, 1);
	assert.deepEqual(hunks[0].before, ["- old line", "+ new line"]);
});

test("unified diff: the habit is diagnosed after the block fails to match", () => {
	const lines = toLines("const a = 1;\nconst b = 2;\n");
	let msg = "";
	try {
		runPatch("@@@\n- const a = 1;\n+ const a = 2;\n@@@", lines);
	} catch (e) {
		msg = (e as Error).message;
	}
	assert.match(msg, /0 of 1 hunk\(s\) applied, nothing was written/);
	assert.match(msg, /mixes 1 "-" marked line\(s\) with 1 "\+" marked line\(s\) — that is a unified diff/);
	assert.match(msg, /A replace patch is: a header line, the old lines without "-"/);
});
