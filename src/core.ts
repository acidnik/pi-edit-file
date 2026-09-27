/**
 * edit_file — pure core: patch parsing, hunk resolution, application, diff.
 *
 * No pi imports here so unit tests can load this file standalone (tsx --test).
 * The extension wrapper lives in ../edit-file.ts.
 *
 * Patch grammar (one hunk or several concatenated):
 *
 *   NNN @@@
 *   before line 1
 *   before line 2
 *   @@@
 *   after line 1
 *   @@@
 *   MMM @@@
 *   ...
 *
 * - NNN is a 1-based line-number hint (anchor), not a strict requirement.
 * - Delimiter: 3+ repetitions of one char from @#%$~^=+. The character is
 *   established by the first delimiter and must stay consistent for the call.
 * - Empty before → insert; empty after → delete; otherwise replace.
 */

export const DELIM_CHARS = "@#%$~^=+";
export const WINDOW = 20;
export const MAX_HUNKS = 20;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Result/context cap for the model-facing diff. */
export const MAX_DIFF_CHARS = 8000;

export class EditError extends Error {}

const HEADER_RE = new RegExp(`^(\\d+)\\s+([${DELIM_CHARS}]{3,})\\s*$`);
const DELIM_RE = new RegExp(`^([${DELIM_CHARS}])\\1{2,}\\s*$`);

export interface Hunk {
	/** 1-based line hint from the header; null when the header was a bare
	 * delimiter (then the before-block must match exactly once). */
	hint: number | null;
	/** Lines to find (empty → insert). */
	before: string[];
	/** Replacement lines (empty → delete). */
	after: string[];
}

export type HunkKind = "replace" | "insert" | "delete";

/** How a before-block was found — models need this to trust the result. */
export type MatchTier = "exact" | "trim" | "collapse";

export interface MatchInfo {
	tier: MatchTier | "hint";
	/** 1-based first line of the match in the ORIGINAL file (insert: target line). */
	from: number;
	/** 1-based last line of the match in the ORIGINAL file (insert: from - 1). */
	to: number;
	hint: number | null;
	/** Distance to the hint (0 when the hint is inside the block; 0 when
	 * there was no hint, since a hintless block must be unique). */
	distance: number;
	/** Matched outside the ±WINDOW hint window (low confidence). */
	farFromHint: boolean;
	/** Other places the same block matches (1-based), closest first. */
	otherMatches?: number[];
	/** Set when the inserted lines use a different indent style than the file. */
	indentMismatch?: string;
}

export interface ResolvedHunk {
	hunk: Hunk;
	kind: HunkKind;
	/** 0-based inclusive start in the ORIGINAL file (insertion index for insert). */
	start: number;
	/** 0-based exclusive end in the ORIGINAL file (== start for insert). */
	end: number;
	match: MatchInfo;
}

function delimiterChar(line: string): string | null {
	const m = DELIM_RE.exec(line);
	if (!m) return null;
	// DELIM_RE forces a single repeated char; sanity-guard anyway.
	if (!new RegExp(`^[${DELIM_CHARS}]+$`).test(m[1])) return null;
	return m[1];
}

/** A hunk header: "NNN @@@", or a bare "@@@" line (hint omitted — the block
 * must then match exactly once in the file). */
export function parseHunkHeader(line: string): { hint: number | null; delim: string } | null {
	const hm = HEADER_RE.exec(line);
	if (hm) return { hint: Number.parseInt(hm[1], 10), delim: hm[2] };
	const ch = delimiterChar(line);
	if (ch !== null) return { hint: null, delim: ch.repeat(3) };
	return null;
}

/**
 * Parse a patch string into hunks.
 * Throws EditError on grammar violations (with actionable messages).
 */
export function parsePatch(patch: string): Hunk[] {
	const lines = patch.split("\n");
	// Drop a single trailing empty line produced by a final newline.
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

	const hunks: Hunk[] = [];
	let delimChar: string | null = null;
	let i = 0;

	const isOwnDelim = (line: string) => delimiterChar(line) === delimChar && delimChar !== null;
	const hintLabel = (hint: number | null) => (hint === null ? "no NNN hint" : `hint ${hint}`);

	while (i < lines.length) {
		// Skip blank separators between hunks.
		if (lines[i].trim() === "") {
			i++;
			continue;
		}

		const header = parseHunkHeader(lines[i]);
		if (!header) {
			throw new EditError(
				`parse error at line ${i + 1}: expected a hunk header — either "NNN @@@ " or a bare "${delimChar ?? "@@@ "}" line — got: ${JSON.stringify(lines[i])}`,
			);
		}
		const hint = header.hint;
		const headerDelim = header.delim;
		const ch = headerDelim[0];
		if (delimChar === null) {
			delimChar = ch;
		} else if (ch !== delimChar) {
			throw new EditError(
				`delimiter character mismatch: header uses "${ch}" but this call already uses "${delimChar}" — use the same delimiter character throughout`,
			);
		}
		i++;

		// Collect before-lines until a delimiter.
		const before: string[] = [];
		const bodyStart = i;
		while (i < lines.length && !isOwnDelim(lines[i])) {
			// Diff-style patch: the model mimicked a unified diff (-old / +new)
			// and skipped the '@@@' delimiter between the old and new blocks.
			if (i > bodyStart && /^\s*\+/.test(lines[i]) && before.some((l) => /^-\s?/.test(l) || /^-\s*$/.test(l))) {
				throw new EditError(
					`parse error at line ${i + 1}: this looks like a unified diff (-old / +new lines), but the patch format needs a "${delimChar}${delimChar}${delimChar}" delimiter between the old and new blocks:\n\n` +
						`${hint} ${delimChar.repeat(3)}\n<old lines, no leading "-">\n${delimChar.repeat(3)}\n<new lines, no leading "+">\n${delimChar.repeat(3)}\n\n` +
						`Strip the leading "-" and "+" markers and keep only the plain line contents.`,
				);
			}
			const other = delimiterChar(lines[i]);
			if (other !== null) {
				throw new EditError(
					`delimiter collision at line ${i + 1}: found "${lines[i].trim()}" but this call uses "${delimChar}" — ${other === delimChar ? "escalate to a longer run (e.g. " + delimChar.repeat(4) + ")" : "keep one delimiter character (" + delimChar + ") for the whole call"}`,
				);
			}
			if (HEADER_RE.test(lines[i])) {
				throw new EditError(
					`parse error at line ${i + 1}: hunk header found before the closing delimiter — missing "@${delimChar === "@" ? "@@" : delimChar + delimChar}" separator?`,
				);
			}
			before.push(lines[i]);
			i++;
		}
		if (i >= lines.length) {
			throw new EditError(
				`parse error: unterminated hunk (${hintLabel(hint)}) — missing closing delimiter between the old and new blocks`,
			);
		}
		i++; // consume the closing delimiter

		// Collect after-lines until: next header, a terminator delimiter, or EOF.
		const after: string[] = [];
		let terminated = false;
		while (i < lines.length) {
			const line = lines[i];
			const headerHere = parseHunkHeader(line);
			if (headerHere && headerHere.hint !== null) break; // NNN header: next hunk starts
			if (headerHere || isOwnDelim(line)) {
				// A bare delimiter is either this hunk's terminator or the next
				// hunk's hintless header. Look ahead: content right after it (that
				// is not itself a header) means the next hunk starts here — leave
				// the delimiter for the outer loop to read as its header.
				let j = i + 1;
				while (j < lines.length && lines[j].trim() === "") j++;
				const nextIsContent = j < lines.length && !parseHunkHeader(lines[j]);
				if (nextIsContent) break;
				i++;
				terminated = true;
				break;
			}
			const other = delimiterChar(line);
			if (other !== null) {
				throw new EditError(
					`delimiter collision at line ${i + 1}: found "${line.trim()}" but this call uses "${delimChar}" — keep one delimiter character for the whole call`,
				);
			}
			after.push(line);
			i++;
		}

		if (before.length === 0 && after.length === 0) {
		throw new EditError(`hunk ${hunks.length + 1} (${hintLabel(hint)}) is empty: both before and after blocks are blank`);
		}
		hunks.push({ hint, before, after });

		if (terminated && i < lines.length && lines[i].trim() === "" && i === lines.length - 1) {
			// trailing blank after the final terminator — harmless
			i++;
		}
	}

	if (hunks.length === 0) throw new EditError("patch contains no hunks");
	if (hunks.length > MAX_HUNKS) {
		throw new EditError(`too many hunks: ${hunks.length} (max ${MAX_HUNKS} per call)`);
	}
	return hunks;
}

type LineEq = (a: string, b: string) => boolean;

const exactEq: LineEq = (a, b) => a === b;
const trimEq: LineEq = (a, b) => a.trim() === b.trim();
const collapseEq: LineEq = (a, b) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

const LADDER: Array<{ name: string; eq: LineEq }> = [
	{ name: "exact", eq: exactEq },
	{ name: "trim", eq: trimEq },
	{ name: "collapse", eq: collapseEq },
];

function blockMatches(lines: string[], start: number, before: string[], eq: LineEq): boolean {
	for (let k = 0; k < before.length; k++) {
		if (!eq(lines[start + k], before[k])) return false;
	}
	return true;
}

function findCandidates(lines: string[], before: string[], hint: number | null, eq: LineEq): number[] {
	const cands: number[] = [];
	// Without a hint there is nothing to be near to: scan the whole file.
	const lo = hint === null ? 0 : Math.max(0, hint - 1 - WINDOW);
	const hi = hint === null ? lines.length - before.length : Math.min(lines.length - before.length, hint - 1 + WINDOW);
	// Window pass first (nearest wins anyway, but the window pass decides
	// whether we trust proximity or must scan the whole file).
	for (let s = lo; s <= hi; s++) {
		if (blockMatches(lines, s, before, eq)) cands.push(s);
	}
	if (cands.length > 0) return cands;
	for (let s = 0; s + before.length <= lines.length; s++) {
		if (s >= lo && s <= hi) continue; // already checked
		if (blockMatches(lines, s, before, eq)) cands.push(s);
	}
	return cands;
}

/** Explain WHY a before-block failed to match: which lines are absent from the
 * file, or in what order/positions they actually appear. Models tend to write
 * blocks with hallucinated line order or reference lines that no longer exist
 * (e.g. removed earlier in the session) — a precise diagnosis saves retries. */
function diagnoseBlock(fileLines: string[], before: string[], hint: number | null): string {
	const MAX_LISTED = 4;
	const firstIndexOf = (needle: string): number => {
		const exact = fileLines.indexOf(needle);
		if (exact >= 0) return exact;
		const trimmed = needle.trim();
		if (trimmed === "") return -1;
		return fileLines.findIndex((l) => l.trim() === trimmed);
	};

	const positions = before.map((line) => firstIndexOf(line));
	const missing = before.filter((_, i) => positions[i] < 0);
	if (missing.length > 0) {
		const shown = missing.slice(0, MAX_LISTED).map((l) => `  ${JSON.stringify(l)}`);
		const more = missing.length > MAX_LISTED ? `\n  … and ${missing.length - MAX_LISTED} more` : "";
		// Character-level near-misses ("1000" vs "1001") read as absent lines;
		// name the closest real line so the model needs no manual comparison.
		const nearMisses = missing
			.slice(0, 2)
			.map((line) => closestLine(fileLines, line, hint))
			.filter((x): x is { index: number; text: string; similarity: number } => x !== undefined)
			.map((x) => `  closest line ${x.index + 1} (${Math.round(x.similarity * 100)}% similar): ${JSON.stringify(x.text)}`);

		// Escaping mistake: the patch is a JSON string, so a real line break in
		// the file is a real line break in the patch. Only claim this when
		// expanding the literal backslash-n into line breaks actually matches the
		// file — otherwise "\n" may be legitimate source content.
		let escapeHint = "";
		if (before.some((l) => /\\n/.test(l))) {
			const expanded = before.flatMap((l) => l.split(/\\n/));
			const allPresent = expanded.length !== before.length && expanded.every((l) => fileLines.includes(l));
			if (allPresent) {
				escapeHint =
					`\nEscaping note: a literal "\\n" in a before-line is a backslash followed by "n", not a line break. ` +
					`Splitting your line at those "\\n" gives the actual file lines, so write each file line on its own patch line ` +
					`and never type \\n yourself (the patch is a JSON string; its line breaks are already real line breaks).`;
			}
		}

		// Before/after mix-up: the block is existing lines followed (or preceded)
		// by lines that do not exist at all. Models write new content in the
		// before block, leaving after empty — then the hunk reads as a delete.
		const firstMissing = positions.findIndex((p) => p < 0);
		const trailingOnly = firstMissing > 0 && positions.slice(firstMissing).every((p) => p < 0);
		const lastMissing = positions.length - 1 - [...positions].reverse().findIndex((p) => p < 0);
		const leadingOnly = lastMissing < positions.length - 1 && positions.slice(0, lastMissing + 1).every((p) => p < 0);
		let swapHint = "";
		if (trailingOnly) {
			swapHint =
				`\nThe first ${firstMissing} line(s) match the file and the trailing ${before.length - firstMissing} do not exist. ` +
				`If those trailing lines are the NEW content you want to add, they belong after the closing delimiter (before = old lines, after = new lines).`;
		} else if (leadingOnly) {
			swapHint =
				`\nThe trailing ${positions.length - 1 - lastMissing} line(s) match the file and the leading ${lastMissing + 1} do not exist. ` +
				`If those leading lines are the NEW content, they belong after the closing delimiter (before = old lines, after = new lines).`;
		}

		return (
			`\nDiagnosis: ${missing.length} of ${before.length} before-block line(s) do not exist in the file at all:\n` +
			shown.join("\n") +
			more +
			(nearMisses.length > 0 ? `\nDid you mean one of these? (typo-level differences count as absent)\n${nearMisses.join("\n")}` : "") +
			escapeHint +
			swapHint
		);
	}

	const outOfOrder = positions.some((p, i) => i > 0 && p <= positions[i - 1]);
	if (outOfOrder) {
		return (
			`\nDiagnosis: every line exists, but NOT in the order written. Actual positions in the file:\n` +
			before.map((l, i) => `  line ${positions[i] + 1}: ${l.trim().slice(0, 80)}`).join("\n") +
			`\nRe-order the before-block to match the file.`
		);
	}

	return (
		`\nDiagnosis: the lines exist in this order but are not contiguous — found at lines ` +
		`${positions.map((p) => p + 1).join(", ")} (expected consecutive lines). Add or remove the gap line(s).`
	);
}

/** Bounded Levenshtein similarity in [0, 1] for two single lines. */
function lineSimilarity(a: string, b: string): number {
	const A = a.length > 200 ? a.slice(0, 200) : a;
	const B = b.length > 200 ? b.slice(0, 200) : b;
	const n = A.length;
	const m = B.length;
	if (n === 0 || m === 0) return 0;
	let prev = new Uint16Array(m + 1);
	let cur = new Uint16Array(m + 1);
	for (let j = 0; j <= m; j++) prev[j] = j;
	for (let i = 1; i <= n; i++) {
		cur[0] = i;
		for (let j = 1; j <= m; j++) {
			const cost = A[i - 1] === B[j - 1] ? 0 : 1;
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
		}
		const swap = prev;
		prev = cur;
		cur = swap;
	}
	return 1 - prev[m] / Math.max(n, m);
}

/** Closest line to `needle` in the file (typo-level near misses). Searches near
 * the hint first; a full scan is length-filtered and candidate-capped so a big
 * file cannot make the failure path expensive. */
function closestLine(
	lines: string[],
	needle: string,
	hint: number,
): { index: number; text: string; similarity: number } | undefined {
	const trimmed = needle.trim();
	if (trimmed.length < 4) return undefined;
	const MIN_SIMILARITY = 0.7;
	const lengthOk = (l: string) => Math.abs(l.length - needle.length) <= Math.max(8, needle.length * 0.4);

	let best: { index: number; text: string; similarity: number } | undefined;
	const consider = (i: number) => {
		const line = lines[i];
		if (!lengthOk(line)) return;
		if (!line.trim()) return;
		const sim = lineSimilarity(needle, line);
		if (sim >= MIN_SIMILARITY && (!best || sim > best.similarity)) best = { index: i, text: line, similarity: sim };
	};

	const lo = Math.max(0, hint - 1 - 100);
	const hi = Math.min(lines.length, hint - 1 + 100);
	for (let i = lo; i < hi; i++) consider(i);
	if (best && best.similarity >= 0.9) return best;

	let examined = 0;
	const MAX_EXAMINED = 5000;
	for (let i = 0; i < lines.length && examined < MAX_EXAMINED; i++) {
		if (i >= lo && i < hi) continue;
		if (!lengthOk(lines[i])) continue;
		examined++;
		consider(i);
	}
	return best;
}

/** Distance from the hint to a matched range; 0 when the hint is inside it.
 * start/end are 0-based (end exclusive), hint is 1-based. */
function rangeDistance(start: number, end: number, hint: number): number {
	const firstLine = start + 1;
	const lastLine = end;
	if (hint >= firstLine && hint <= lastLine) return 0;
	if (hint < firstLine) return firstLine - hint;
	return hint - lastLine;
}

/** Detect a silent indent-style change: the file is indented with tabs (or
 * spaces) while the patch's indented lines use the other style. Judged against
 * the whole file, because a matched block may contain top-level lines and would
 * otherwise skew the majority. Only reported, never rewritten — the model may
 * be re-indenting on purpose. */
function indentMismatch(fileLines: string[], start: number, hunk: Hunk): string | undefined {
	const indentedAfter = hunk.after.filter((l) => l.trim() !== "" && /^\s/.test(l));
	if (indentedAfter.length === 0) return undefined;

	const tabsIn = (lines: string[]) => lines.filter((l) => /^\t/.test(l)).length;
	let fileIndentedTabs = 0;
	let fileIndentedSpaces = 0;
	for (const line of fileLines) {
		if (line.trim() === "" || !/^\s/.test(line)) continue;
		if (/^\t/.test(line)) fileIndentedTabs++;
		else fileIndentedSpaces++;
	}
	if (fileIndentedTabs === 0 && fileIndentedSpaces === 0) return undefined;
	const fileUsesTabs = fileIndentedTabs > fileIndentedSpaces;

	const patchIndentedTabs = tabsIn(indentedAfter);
	const patchIndentedSpaces = indentedAfter.length - patchIndentedTabs;
	const patchUsesTabs = patchIndentedTabs > patchIndentedSpaces;
	if (fileUsesTabs === patchUsesTabs) return undefined;
	return fileUsesTabs
		? "file indents with tabs, the patch's new lines use spaces"
		: "file indents with spaces, the patch's new lines use tabs";
}

function contextDump(lines: string[], hint: number | null): string {
	// Without a hint there is no centre; show the head of the file instead.
	const center = hint === null ? Math.min(3, lines.length) : Math.min(Math.max(hint, 1), lines.length);
	const from = Math.max(0, center - 4);
	const to = Math.min(lines.length, center + 3);
	const pad = String(to).length;
	const rows: string[] = [];
	for (let n = from; n < to; n++) {
		rows.push(`${String(n + 1).padStart(pad)} | ${lines[n]}`);
	}
	return rows.join("\n");
}

export interface HunkFailure {
	/** 0-based hunk index in the patch. */
	index: number;
	hint: number;
	kind: HunkKind;
	/** One-line reason. */
	reason: string;
	/** Extra multi-line detail (diagnosis, context dump). */
	detail: string;
	/** Ready-to-paste corrected hunk, when a close candidate was found. */
	suggestion?: string;
	/** Would this hunk have matched if it were alone? (failure causes: ambiguity) */
	wouldMatch?: { from: number; to: number; tier: MatchTier };
}

export interface ResolveReport {
	/** Filled only when every hunk resolved. */
	resolved: ResolvedHunk[];
	failures: HunkFailure[];
}

/** Resolve one hunk; never throws — failures are returned as data. */
function resolveOne(hunk: Hunk, fileLines: string[], index: number): { ok: ResolvedHunk } | { fail: HunkFailure } {
	const hint = hunk.hint;
	const kind: HunkKind = hunk.before.length === 0 ? "insert" : hunk.after.length === 0 ? "delete" : "replace";

	if (hunk.before.length === 0) {
		if (hint === null) {
			return {
				fail: {
					index,
					hint,
					kind,
					reason: "this hunk has no NNN hint, but an insert has no block to match — there is nothing that says where to insert",
					detail: '\nWrite a line number in the header, e.g. "42 @@@", giving the line the new content goes before.',
				},
			};
		}
		const idx = Math.min(Math.max(hint - 1, 0), fileLines.length);
		return {
			ok: {
				hunk,
				kind: "insert",
				start: idx,
				end: idx,
				match: { tier: "hint", from: idx + 1, to: idx, hint, distance: 0, farFromHint: false },
			},
		};
	}

	if (hunk.before.length > fileLines.length) {
		return {
			fail: {
				index,
				hint,
				kind,
				reason: `before-block has ${hunk.before.length} lines but the file only has ${fileLines.length}`,
				detail: "",
			},
		};
	}

	let candidates: number[] | null = null;
	let tier: MatchTier = "exact";
	for (const level of LADDER) {
		const c = findCandidates(fileLines, hunk.before, hint, level.eq);
		if (c.length > 0) {
			candidates = c;
			tier = level.name as MatchTier;
			break;
		}
	}

	if (!candidates || candidates.length === 0) {
		let diffStyleHint = "";
		if (hunk.before.some((l) => /^\s*\+/.test(l))) {
			diffStyleHint =
				`\nThe before-block contains lines starting with "+" — this looks like a unified diff. ` +
				`The patch format is: NNN @@@ / old lines (no "-") / @@@ / new lines (no "+") — write plain line contents without +/- markers.`;
		}
		const suggestion = suggestCorrection(fileLines, hunk);
		return {
			fail: {
				index,
				hint,
				kind,
				reason: "before-block not found (exact, trim and whitespace-collapse matching all failed)",
				detail:
					`${diffStyleHint}${diagnoseBlock(fileLines, hunk.before, hint)}\n` +
					(hint === null ? `File head:\n` : `Lines around ${hint}:\n`) +
					`${contextDump(fileLines, hint)}` +
					(suggestion ? `\n${suggestion.text}` : ""),
				suggestion: suggestion?.patch,
			},
		};
	}

	// Closest to the hint wins; a distance tie is ambiguous.
	// Distance is measured to the matched RANGE (0 when the hint falls inside
	// the block), not to its first line — that is what "how far is this block
	// from where I asked" means to the caller.
	const distOf = (start: number) => rangeDistance(start, start + hunk.before.length, hint);
	let best = candidates[0];
	let bestDist = distOf(best);
	for (const c of candidates) {
		const d = distOf(c);
		if (d < bestDist || (d === bestDist && c < best)) {
			best = c;
			bestDist = d;
		}
	}
	// A hintless hunk (bare delimiter header) has no proximity to fall back on:
	// it must match exactly once, or the caller has to say where it means.
	if (hint === null && candidates.length > 1) {
		const list = candidates.map((c) => `${c + 1}`).join(", ");
		return {
			fail: {
				index,
				hint,
				kind,
				reason: `no NNN hint given and the block matches at lines ${list}`,
				detail:
					`\nAdd a line number to the header (e.g. "${candidates[0] + 1} @@@") to pick one, ` +
					`or include more surrounding lines in the before-block so the match is unique.`,
				wouldMatch: { from: candidates[0] + 1, to: candidates[0] + hunk.before.length, tier },
			},
		};
	}

	const ties = candidates.filter((c) => distOf(c) === bestDist);
	if (ties.length > 1) {
		const list = ties.map((c) => `${c + 1}`).join(", ");
		return {
			fail: {
				index,
				hint,
				kind,
				reason: `ambiguous — block matches at lines ${list}, equally close to the hint`,
				detail: "\nAdd surrounding unique lines to the before-block to disambiguate.",
				wouldMatch: { from: best + 1, to: best + hunk.before.length, tier },
			},
		};
	}

	const others = hint === null
		? []
		: candidates
				.filter((c) => c !== best)
				.sort((a, b) => distOf(a) - distOf(b))
				.slice(0, 5)
				.map((c) => c + 1);

	return {
		ok: {
			hunk,
			kind,
			start: best,
			end: best + hunk.before.length,
			match: {
				tier,
				from: best + 1,
				to: best + hunk.before.length,
				hint,
				distance: bestDist,
				farFromHint: bestDist > WINDOW,
				otherMatches: others.length > 0 ? others : undefined,
				indentMismatch: indentMismatch(fileLines, best, hunk),
			},
		},
	};
}

/** Resolve every hunk; errors are collected instead of thrown. */
export function resolveAllHunks(hunks: Hunk[], fileLines: string[]): ResolveReport {
	const resolved: ResolvedHunk[] = [];
	const failures: HunkFailure[] = [];
	hunks.forEach((hunk, index) => {
		const out = resolveOne(hunk, fileLines, index);
		if ("ok" in out) resolved.push(out.ok);
		else failures.push(out.fail);
	});

	// Resolved successes are kept even when other hunks fail, so the error can
	// tell the model exactly which hunks would have matched (nothing is written).
	if (failures.length > 0) return { resolved, failures };

	// Overlap check (resolved positions are against the original).
	const sorted = [...resolved].sort((a, b) => a.start - b.start || a.end - b.end);
	for (let k = 1; k < sorted.length; k++) {
		if (sorted[k].start < sorted[k - 1].end) {
			const a = sorted[k - 1];
			const b = sorted[k];
			return {
				resolved: [],
				failures: [
					{
						index: resolved.indexOf(b),
						hint: b.hunk.hint,
						kind: b.kind,
						reason: `overlaps hunk ${resolved.indexOf(a) + 1}: lines ${a.start + 1}-${a.end} and ${b.start + 1}-${b.end}`,
						detail: "\nMerge the overlapping hunks into one, or give them distinct non-overlapping blocks.",
						wouldMatch: { from: b.start + 1, to: b.end, tier: b.match.tier as MatchTier },
					},
				],
			};
		}
	}

	return { resolved, failures: [] };
}

/**
 * Resolve every hunk against the ORIGINAL file content.
 * Throws a single EditError describing the whole batch when anything fails —
 * the caller never wrote anything, and the error says so (plus the fate of
 * every other hunk), so a model can never mistake a rejected batch for an
 * applied one.
 */
export function resolveHunks(hunks: Hunk[], fileLines: string[]): ResolvedHunk[] {
	const report = resolveAllHunks(hunks, fileLines);
	if (report.failures.length === 0) return report.resolved;

	const lines: string[] = [
		`batch rejected — 0 of ${hunks.length} hunk(s) applied, nothing was written to the file.`,
	];
	const byIndex = new Map<number, ResolvedHunk>();
	for (const [i, hunk] of hunks.entries()) {
		const r = report.resolved.find((x) => x.hunk === hunk);
		if (r) byIndex.set(i, r);
	}
	// Full detail for the first couple of failures; the rest stay one-line to
	// keep the error readable for large batches.
	const DETAIL_LIMIT = 2;
	report.failures.forEach((f, k) => {
		const detail = k < DETAIL_LIMIT ? f.detail : f.detail ? "\n(details omitted — fix the failures above first)" : "";
		lines.push(`hunk ${f.index + 1}: REJECTED — ${f.reason}${detail}`);
	});
	for (let i = 0; i < hunks.length; i++) {
		if (report.failures.some((f) => f.index === i)) continue;
		const r = byIndex.get(i);
		if (r) {
			lines.push(
						`hunk ${i + 1}: would have matched (${r.kind} src lines ${r.match.from}-${r.match.to}, ${r.match.tier}${r.match.hint !== null && r.match.distance > 0 ? `, hint ${r.match.hint} off by ${r.match.distance}` : ""}) — NOT applied.`,
			);
		}
	}
	const withSuggestion = report.failures.find((f) => f.suggestion);
	if (withSuggestion?.suggestion) {
		lines.push(`\nSuggested corrected hunk for hunk ${withSuggestion.index + 1}:\n${withSuggestion.suggestion}`);
	}
	throw new EditError(lines.join("\n"));
}

/** Find the closest near-match region and build a ready-to-paste corrected hunk. */
function suggestCorrection(
	fileLines: string[],
	hunk: Hunk,
): { text: string; patch: string } | undefined {
	const before = hunk.before;
	if (before.length === 0) return undefined;

	// Anchor on the longest line of the block (most distinctive) and score every
	// alignment that contains it; also score alignments anchored on the first line.
	const anchorIdx = before.reduce((best, l, i) => (l.trim().length > before[best].trim().length ? i : best), 0);
	const anchors: Array<{ line: number; offset: number }> = [];
	const starts = new Set<number>();
	for (const offset of new Set([anchorIdx, 0])) {
		const needle = before[offset];
		fileLines.forEach((line, i) => {
			if (line === needle) {
				starts.add(i - offset);
				anchors.push({ line: i, offset });
			}
		});
	}

	const scoreAt = (start: number): number => {
		if (start < 0 || start + before.length > fileLines.length) return -1;
		let score = 0;
		for (let k = 0; k < before.length; k++) {
			const a = fileLines[start + k];
			const b = before[k];
			if (a === b) score += 1;
			else if (a.trim() === b.trim() && b.trim() !== "") score += 0.75;
			else if (a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim() && b.trim() !== "") score += 0.5;
		}
		return score;
	};

	let bestStart = -1;
	let bestScore = -1;
	for (const s of starts) {
		const score = scoreAt(s);
		if (score > bestScore) {
			bestScore = score;
			bestStart = s;
		}
	}
	if (bestStart < 0 || bestScore < 1) return undefined;

	const actual = fileLines.slice(bestStart, bestStart + before.length);
	const matched = actual.filter(
		(a, k) => a === before[k] || a.trim() === before[k].trim() || a.replace(/\s+/g, " ").trim() === before[k].replace(/\s+/g, " ").trim(),
	).length;
	const detail: string[] = [];
	detail.push(
		`\nClosest candidate: lines ${bestStart + 1}-${bestStart + before.length} — ${matched} of ${before.length} line(s) match.`,
	);
	detail.push("Actual file content there:");
	detail.push(...actual.map((l, k) => `  ${String(bestStart + k + 1).padStart(4)} | ${l === before[k] ? "=" : "≠"} ${l}`));
	if (before.some((l, k) => l !== actual[k])) {
		detail.push("Lines your before-block has that the file does not (≠ above):");
		before.forEach((l, k) => {
			if (l !== actual[k]) detail.push(`  ${JSON.stringify(l)}`);
		});
	}

	// Ready-to-paste hunk: the real file lines as before, the model's after-block
	// as after (plus a before/after mix-up repair when applicable).
	const missingSuffix = before.findIndex((l) => !actual.includes(l));
	let afterLines = hunk.after;
	if (afterLines.length === 0 && missingSuffix > 0 && before.slice(missingSuffix).every((l) => !actual.includes(l))) {
		afterLines = [...actual, ...before.slice(missingSuffix)];
	}
	const patch =
		`${bestStart + 1} @@@\n` +
		actual.join("\n") +
		`\n@@@\n` +
		afterLines.join("\n") +
		(afterLines.length > 0 ? "\n@@@" : "");

	return { text: detail.join("\n"), patch };
}

/** Apply resolved hunks to the original lines. Positions must not overlap. */
export function applyHunks(fileLines: string[], resolved: ResolvedHunk[]): string[] {
	const out = [...fileLines];
	// Bottom-up so earlier positions stay valid.
	const desc = [...resolved].sort((a, b) => b.start - a.start || b.end - a.end);
	for (const r of desc) {
		out.splice(r.start, r.end - r.start, ...r.hunk.after);
	}
	return out;
}

/** Minimal LCS diff for small line arrays (used per-hunk with context). */
function lcsDiff(oldLines: string[], newLines: string[]): string[] {
	const n = oldLines.length;
	const m = newLines.length;
	// Small chunks only; cap to keep memory sane.
	if (n * m > 1_000_000) {
		return [...oldLines.map((l) => "-" + l), ...newLines.map((l) => "+" + l)];
	}
	const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	const out: string[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (oldLines[i] === newLines[j]) {
			out.push("  " + oldLines[i]);
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			out.push("-" + oldLines[i]);
			i++;
		} else {
			out.push("+" + newLines[j]);
			j++;
		}
	}
	while (i < n) out.push("-" + oldLines[i++]);
	while (j < m) out.push("+" + newLines[j++]);
	return out;
}

const CONTEXT = 2;

export interface HunkReport {
	kind: HunkKind;
	/** 1-based line range in the ORIGINAL (source) file. */
	from: number;
	to: number;
	beforeCount: number;
	afterCount: number;
	tier: MatchTier | "hint";
	hint: number | null;
	distance: number;
	farFromHint: boolean;
}

export function hunkSummary(r: ResolvedHunk, index: number): HunkReport {
	void index;
	return {
		kind: r.kind,
		from: r.start + 1,
		to: r.end,
		beforeCount: r.hunk.before.length,
		afterCount: r.hunk.after.length,
		tier: r.match.tier,
		hint: r.match.hint,
		distance: r.match.distance,
		farFromHint: r.match.farFromHint,
	};
}

/** Model-facing one-line report per hunk: what happened, where it landed, how
 * confident the match was, and the unambiguous source → result line mapping. */
export function formatHunkReport(r: ResolvedHunk, index: number, outFrom: number): string {
	const label = r.kind === "insert" ? "insert" : r.kind === "delete" ? "delete" : "replace";
	const outTo = outFrom + Math.max(r.hunk.after.length - 1, 0);
	const srcRange = r.kind === "insert" ? `src line ${r.match.from}` : `src ${r.match.from}-${r.match.to}`;
	const outRange = r.hunk.after.length === 0 ? "removed" : r.kind === "insert" ? `out line ${outFrom}` : `out ${outFrom}-${outTo}`;
	const tier = r.match.tier === "hint" ? "" : `, ${r.match.tier} match`;
	const off =
		r.match.tier === "hint" || r.match.hint === null || r.match.distance === 0
			? ""
			: `, hint ${r.match.hint} off by ${r.match.distance}`;
	const hintless = r.match.hint === null && r.match.tier !== "hint" ? ", unique match (no hint given)" : "";
	const warn = r.match.farFromHint ? " [LOW CONFIDENCE: matched outside the ±20 line window]" : "";
	const others = r.match.otherMatches?.length
		? ` [also matches at line${r.match.otherMatches.length === 1 ? "" : "s"} ${r.match.otherMatches.join(", ")} — verify the right one]`
		: "";
	const indent = r.match.indentMismatch ? ` [indentation: ${r.match.indentMismatch} — the new lines keep the patch's style]` : "";
	return `hunk ${index + 1}: ${label} ${srcRange} → ${outRange} (${r.hunk.before.length} → ${r.hunk.after.length} lines)${tier}${hintless}${off}${warn}${others}${indent}`;
}

/** Per-hunk unified-style diff with a couple of context lines. */
export function hunkDiff(original: string[], updated: string[], r: ResolvedHunk): string {
	const ctxFrom = Math.max(0, r.start - CONTEXT);
	const ctxTo = Math.min(original.length, r.end + CONTEXT);
	const head = original.length === 0 ? "" : `@@ -${r.start + 1},${r.end - r.start} +${r.start + 1} @@`;
	if (r.kind === "insert" && original.length === 0) {
		return `@@ +1 @@ (new file content)\n` + r.hunk.after.map((l) => "+" + l).join("\n");
	}
	const oldSlice = original.slice(ctxFrom, ctxTo);
	// Rebuild the new slice for this region by splicing the hunk into the context window.
	const relStart = r.start - ctxFrom;
	const relEnd = r.end - ctxFrom;
	const newSlice = [
		...oldSlice.slice(0, relStart),
		...(r.kind === "insert" ? r.hunk.after : r.kind === "delete" ? [] : r.hunk.after),
		...oldSlice.slice(relEnd),
	];
	const body = lcsDiff(oldSlice, newSlice);
	return [head, ...body].join("\n");
}

/** Per-hunk diffs computed sequentially: each hunk is diffed against the
 * file state AFTER the previous hunks of the same call were applied, so
 * context lines always reflect the final content. */
export function sequentialDiffs(original: string[], resolved: ResolvedHunk[]): string[] {
	const sorted = [...resolved].sort((a, b) => a.start - b.start);
	let cur = [...original];
	let delta = 0;
	const diffs: string[] = [];
	for (const r of sorted) {
		const rebased: ResolvedHunk = { ...r, start: r.start + delta, end: r.end + delta };
		const before = cur;
		cur = applyHunks(cur, [rebased]);
		diffs.push(hunkDiff(before, cur, rebased));
		delta += r.hunk.after.length - (r.end - r.start);
	}
	return diffs;
}

export function truncateDiff(diff: string, max = MAX_DIFF_CHARS): { text: string; truncated: boolean } {
	if (diff.length <= max) return { text: diff, truncated: false };
	return { text: diff.slice(0, max) + "\n… (diff truncated)", truncated: true };
}

export interface EditOutcome {
	reports: HunkReport[];
	/** Model-facing one-line report per hunk (src → out line mapping). */
	lines: string[];
	totalLines: number;
	diff: string;
	diffTruncated: boolean;
}

/** Convenience: parse + resolve + apply + summarize in one call. */
export function runPatch(patch: string, fileLines: string[]): EditOutcome {
	const hunks = parsePatch(patch);
	const resolved = resolveHunks(hunks, fileLines);
	const updated = applyHunks(fileLines, resolved);
	const reports = resolved.map((r, i) => hunkSummary(r, i));
	const lines = formatHunkReports(resolved);
	const diff = sequentialDiffs(fileLines, resolved).join("\n");
	const { text, truncated } = truncateDiff(diff);
	return { reports, lines, totalLines: updated.length, diff: text, diffTruncated: truncated };
}

/** Reports for the whole batch, with result-side line numbers resolved. */
export function formatHunkReports(resolved: ResolvedHunk[]): string[] {
	const ascending = [...resolved].sort((a, b) => a.start - b.start);
	const outStart = new Map<ResolvedHunk, number>();
	let delta = 0;
	for (const r of ascending) {
		outStart.set(r, r.start + 1 + delta);
		delta += r.hunk.after.length - (r.end - r.start);
	}
	return resolved.map((r, i) => formatHunkReport(r, i, outStart.get(r) ?? r.start + 1));
}

// ---------------------------------------------------------------------------
// Whole-file unified diff (used by the `write` override to show overwrites)
// ---------------------------------------------------------------------------

/** Cell budget for the LCS table; larger middles fall back to one coarse block. */
const LCS_CELL_LIMIT = 100_000;

const NO_NEWLINE = "\\ No newline at end of file";

type DiffOp = { type: "=" | "-" | "+"; text: string };

/** LCS-based line edit script for the changed middle of two files. */
function lcsOps(a: string[], b: string[]): DiffOp[] {
	const n = a.length;
	const m = b.length;
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}

	const ops: DiffOp[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			ops.push({ type: "=", text: a[i] });
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			ops.push({ type: "-", text: a[i] });
			i++;
		} else {
			ops.push({ type: "+", text: b[j] });
			j++;
		}
	}
	while (i < n) ops.push({ type: "-", text: a[i++] });
	while (j < m) ops.push({ type: "+", text: b[j++] });
	return ops;
}

/**
 * Unified diff of two text blobs, in the format pi's renderDiff parses.
 *
 * A trailing newline is a line terminator, not an extra empty line (GNU diff
 * semantics), so it is stripped before splitting; a file whose last line lacks
 * the newline gets the usual "\ No newline at end of file" marker. Common
 * prefix/suffix lines are trimmed before diffing, so the LCS table stays small;
 * if the changed middle is still huge the diff degrades to one replace block
 * instead of allocating a giant table. Returns "" when the texts are equal.
 */
export function unifiedDiff(oldText: string, newText: string, filePath: string, context = 3): string {
	if (oldText === newText) return "";

	const oldHasNL = oldText.endsWith("\n");
	const newHasNL = newText.endsWith("\n");
	const a = (oldHasNL ? oldText.slice(0, -1) : oldText).split("\n");
	const b = (newHasNL ? newText.slice(0, -1) : newText).split("\n");

	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
	let endA = a.length;
	let endB = b.length;
	while (endA > prefix && endB > prefix && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}

	const midA = a.slice(prefix, endA);
	const midB = b.slice(prefix, endB);

	const ops: DiffOp[] = [];
	for (let k = 0; k < prefix; k++) ops.push({ type: "=", text: a[k] });
	if (midA.length * midB.length <= LCS_CELL_LIMIT) {
		ops.push(...lcsOps(midA, midB));
	} else {
		for (const line of midA) ops.push({ type: "-", text: line });
		for (const line of midB) ops.push({ type: "+", text: line });
	}
	for (let k = endA; k < a.length; k++) ops.push({ type: "=", text: a[k] });

	// Only the final newline differs: show it as a changed last line, like GNU diff.
	if (ops.every((op) => op.type === "=")) {
		const last = ops[ops.length - 1];
		if (last === undefined) return "";
		ops.splice(ops.length - 1, 1, { type: "-", text: last.text }, { type: "+", text: last.text });
	}

	// Counts of a-side / b-side lines before each op index (1-based hunk starts).
	const aBefore: number[] = new Array(ops.length + 1).fill(0);
	const bBefore: number[] = new Array(ops.length + 1).fill(0);
	let lastA = -1;
	let lastB = -1;
	for (let k = 0; k < ops.length; k++) {
		aBefore[k + 1] = aBefore[k] + (ops[k].type === "+" ? 0 : 1);
		bBefore[k + 1] = bBefore[k] + (ops[k].type === "-" ? 0 : 1);
		if (ops[k].type !== "+") lastA = k;
		if (ops[k].type !== "-") lastB = k;
	}

	// Keep every changed op plus `context` lines around it.
	const keep: boolean[] = new Array(ops.length).fill(false);
	for (let k = 0; k < ops.length; k++) {
		if (ops[k].type === "=") continue;
		const from = Math.max(0, k - context);
		const to = Math.min(ops.length - 1, k + context);
		for (let d = from; d <= to; d++) keep[d] = true;
	}

	// git-style a/ b/ labels for relative paths; absolute paths stand alone
	// (otherwise "/tmp/x" would render as the misleading "a//tmp/x").
	const labels: [string, string] = filePath.startsWith("/")
		? [filePath, filePath]
		: [`a/${filePath}`, `b/${filePath}`];
	const out: string[] = [`--- ${labels[0]}`, `+++ ${labels[1]}`];
	let k = 0;
	while (k < ops.length) {
		if (!keep[k]) {
			k++;
			continue;
		}
		let end = k;
		while (end + 1 < ops.length && keep[end + 1]) end++;

		const aCount = aBefore[end + 1] - aBefore[k];
		const bCount = bBefore[end + 1] - bBefore[k];
		out.push(`@@ -${aBefore[k] + 1},${aCount} +${bBefore[k] + 1},${bCount} @@`);
		for (let d = k; d <= end; d++) {
			out.push(`${ops[d].type === "=" ? " " : ops[d].type}${ops[d].text}`);
			if (d === lastA && !oldHasNL) out.push(NO_NEWLINE);
			if (d === lastB && !newHasNL) out.push(NO_NEWLINE);
		}
		k = end + 1;
	}

	return out.join("\n");
}

// ---------------------------------------------------------------------------
// Unified-diff parsing + word-level diff (for syntax-highlighted diff rendering)
// ---------------------------------------------------------------------------

export type DiffLineKind = " " | "-" | "+";

export interface ParsedDiffLine {
	kind: DiffLineKind;
	text: string;
}

export interface ParsedHunk {
	/** Original "@@ -a,b +c,d @@" header, for display. */
	header: string;
	/** 1-based first line of this hunk in the NEW file. */
	bStart: number;
	lines: ParsedDiffLine[];
}

/**
 * Parse a unified diff produced by unifiedDiff(). File headers are dropped and
 * "\ No newline at end of file" markers are ignored (they carry no content).
 */
export function parseUnifiedDiff(diffText: string): ParsedHunk[] {
	const hunks: ParsedHunk[] = [];
	let current: ParsedHunk | undefined;

	for (const line of diffText.split("\n")) {
		if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
		if (line.startsWith("@@")) {
			const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
			current = { header: line, bStart: m ? Number(m[1]) : 1, lines: [] };
			hunks.push(current);
			continue;
		}
		if (current === undefined) continue;
		if (line.startsWith("\\")) continue;
		const kind = line[0];
		if (kind !== " " && kind !== "-" && kind !== "+") continue;
		current.lines.push({ kind: kind as DiffLineKind, text: line.slice(1) });
	}

	return hunks;
}

export interface WordSegment {
	text: string;
	/** True for the words this edit actually changed. */
	changed: boolean;
}

/** Split a line into coarse tokens: words, whitespace runs, single symbols. */
function wordTokens(line: string): string[] {
	return line.match(/\s+|[A-Za-z0-9_]+|./g) ?? [];
}

/**
 * Word-level diff of two lines, for the usual "one removed / one added" pair.
 * Returns segments for both sides that concatenate back to the input exactly;
 * `changed` marks tokens absent from the other side.
 */
export function wordDiffPair(oldLine: string, newLine: string): { old: WordSegment[]; new: WordSegment[] } {
	const a = wordTokens(oldLine);
	const b = wordTokens(newLine);
	const n = a.length;
	const m = b.length;

	// LCS table over tokens (lines are short, so this stays cheap).
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}

	const oldSegments: WordSegment[] = [];
	const newSegments: WordSegment[] = [];
	const push = (arr: WordSegment[], text: string, changed: boolean) => {
		const last = arr[arr.length - 1];
		if (last && last.changed === changed) last.text += text;
		else arr.push({ text, changed });
	};

	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			push(oldSegments, a[i], false);
			push(newSegments, b[j], false);
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			push(oldSegments, a[i], true);
			i++;
		} else {
			push(newSegments, b[j], true);
			j++;
		}
	}
	while (i < n) push(oldSegments, a[i++], true);
	while (j < m) push(newSegments, b[j++], true);

	return { old: oldSegments, new: newSegments };
}
