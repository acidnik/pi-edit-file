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
	formatHunkReports,
	sequentialDiffs,
	EditError,
	WINDOW,
	unifiedDiff,
	parseUnifiedDiff,
	wordDiffPair,
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

test("parse: mixed delimiter chars rejected", () => {
	assert.throws(() => parsePatch("1 @@@\nfoo\n%%%\nbar\n@@@"), EditError);
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

test("resolve: closest candidate wins over another match", () => {
	const lines = toLines("dup\ndup\nmid\ndup\ndup");
	const out = runPatch("1 @@@\ndup\n@@@\nUNIQ\n@@@", lines);
	assert.equal(out.reports[0].from, 1);
});

test("resolve: ambiguity within window → error listing candidates", () => {
	const lines = toLines("dup\ndup\nmid\ndup\ndup");
	// hint 3 is exactly between line 2 and line 4
	assert.throws(() => runPatch("3 @@@\ndup\n@@@\nUNIQ\n@@@", lines), /ambiguous/);
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
	assert.match(out.diff, /@@ -4,1 \+4 @@/);
	assert.match(out.diff, /beta = 2/); // context line
});

test("hunkDiff: insert into empty file", () => {
	const out = runPatch("1 @@@\n@@@\nfirst\nsecond\n@@@", []);
	assert.equal(out.totalLines, 2);
	assert.match(out.diff, /\+first/);
});
test("parse: delimiter collision (different char) errors clearly", () => {
	assert.throws(() => parsePatch("1 @@@\n%%%\n@@@\nx\n@@@"), /collision/);
});
test("sequentialDiffs: context reflects earlier hunks, headers rebased", () => {
	const lines = toLines("a\nold1\nmid\nold2\nz");
	const patch = "2 @@@\nold1\n@@@\nnew1\nextra\n@@@\n4 @@@\nold2\n@@@\nnew2\n@@@";
	const resolved = resolveHunks(parsePatch(patch), lines);
	const parts = sequentialDiffs(lines, resolved);

	// hunk 1: 1→2 lines (net +1)
	assert.match(parts[0], /\+new1\n\+extra/);

	// hunk 2 header rebased by +1: in the intermediate state old2 sits at line 5
	assert.match(parts[1], /@@ -5,1 \+5 @@/);
	// context around hunk 2 shows content created by hunk 1 (extra), not the original
	assert.match(parts[1], /extra/);
	assert.doesNotMatch(parts[1], /new1/); // 2-line context window doesn't reach line 2
	assert.match(parts[1], /\+new2/);
});

test("parse: diff-style patch (missing middle delimiter) gets actionable error", () => {
	// exactly what glm-5.3-flash wrote in session 2026-09-25: -old lines then +new, no @@@ between
	const diffStyle = "56 @@@\n-function saveCheckpoint(doneIds) {\n-  const done = [];\n+// --- checkpoint helpers ---";
	assert.throws(() => parsePatch(diffStyle), /looks like a unified diff/);
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
	const lines = toLines("dup\ndup\nmid\ndup\ndup\n");
	let msg = "";
	try {
		runPatch("3 @@@\ndup\n@@@\nUNIQ\n@@@\n5 @@@\ndup\n@@@\nLAST\n@@@", lines);
	} catch (e) {
		msg = (e as Error).message;
	}
	assert.match(msg, /0 of 2 hunk\(s\) applied, nothing was written/);
	assert.match(msg, /hunk 1: REJECTED — ambiguous/);
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

test("match info: alternative match locations are surfaced (repetitive snippets)", () => {
	const lines = toLines("dup\ndup\nmid\ndup\ndup\n");
	// hint 2: nearest is line 2, but line 1/4/5 also match the same snippet
	const resolved = resolveHunks(parsePatch("2 @@@\ndup\n@@@\nUNIQ\n@@@"), lines);
	assert.equal(resolved[0].match.from, 2);
	assert.deepEqual(resolved[0].match.otherMatches, [1, 4, 5]);

	const report = formatHunkReports(resolved)[0];
	assert.match(report, /also matches at lines 1, 4, 5 — verify the right one/);
});

test("match info: unique match has no alternative list", () => {
	const resolved = resolveHunks(parsePatch("2 @@@\nbbb\n@@@\nB\n@@@"), toLines("aaa\nbbb\nccc\n"));
	assert.equal(resolved[0].match.otherMatches, undefined);
	assert.doesNotMatch(formatHunkReports(resolved)[0], /also matches/);
});

test("ambiguity: equal distance to the matched RANGE is a hard error", () => {
	// two byte-identical blocks flanking the hint (one line away from each)
	const lines = toLines("a\n.name {\n\tflex: 1;\n}\nb\n.name {\n\tflex: 1;\n}\n");
	assert.throws(
		() => runPatch("5 @@@\n.name {\n\tflex: 1;\n}\n@@@\n.name {\n\tflex: 9;\n}\n@@@", lines),
		/ambiguous — block matches at lines 2, 6, equally close to the hint/,
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

test("hintless: two matching blocks require NNN", () => {
	const lines = toLines("a\n.name {\n\tflex: 1;\n}\nb\n.name {\n\tflex: 1;\n}\n");
	let msg = "";
	try {
		runPatch("@@@\n.name {\n\tflex: 1;\n}\n@@@\n.name {\n\tflex: 9;\n}\n@@@", lines);
	} catch (e) {
		msg = (e as Error).message;
	}
	assert.match(msg, /no NNN hint given and the block matches at lines 2, 6/);
	assert.match(msg, /Add a line number to the header/);
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
