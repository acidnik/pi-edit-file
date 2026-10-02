/**
 * edit_file — block-based file editing tool for pi.
 *
 * One flat patch string instead of target_edit's 7-variant anyOf ops schema
 * (models kept mixing quick_edit/target_edit schemas → 8.2% validation errors,
 * fixed at the source by this tool).
 *
 * See src/core.ts for the parser/resolver/applier and
 * block-edit-plan.md for rationale. Name decided: edit_file.
 *
 * Also withdraws pi's built-in `edit` tool (exact text replacement), so edit_file
 * is the only edit path, and overrides the built-in `write` tool: overwriting an
 * existing file renders the same diff (per-line syntax highlighting, word-level
 * emphasis, line backgrounds) instead of the content preview.
 */

import { Type } from "typebox";
import {
	createWriteToolDefinition,
	getLanguageFromPath,
	highlightCode,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
	MAX_FILE_BYTES,
	EditError,
	unifiedDiff,
	type Hunk,
	chainSkeleton,
	formatHunkReports,
	hunkSummary,
	isNoOpHunk,
	applyHunks,
	parsePatch,
	resolveHunks,
	sequentialDiffs,
	truncateDiff,
	parseUnifiedDiff,
	patchDelimiter,
	reportCaveats,
	insertTip,
} from "./core.ts";

const TOOL_NAME = "edit_file";

/** pi's built-in exact-text edit tool; withdrawn by editFileExtension(). */
const BUILTIN_EDIT_TOOL = "edit";

const DESCRIPTION = `Edit a file with one or more block patches in a single 'patch' string.

Three shapes — pick the shortest one that expresses the edit:

1) replace, anchored (NNN is a 1-based line hint, not strict):
42 @@@
const timeout = 1000
@@@
const timeout = 5000
@@@

2) replace by content only — omit the number and the block must occur exactly once in the file:
@@@
const timeout = 1000
@@@
const timeout = 5000
@@@

3) insert lines with an empty old block: "NNN @@@" inserts BEFORE line NNN, "NNN+ @@@" inserts AFTER it:
120+ @@@
@@@
export const maxRetries = 3
@@@

- Replace: NNN is where the old block starts in the file — a hint, not a strict address; the block itself is found by content (see Matching below). It may be omitted entirely, and then the block must occur exactly once.
- The patch is a JSON string: one patch line is one file line. Never type "\\n" yourself — write real line breaks. Backticks, \${...} and quotes need no escaping.
- @@@: delimiter, 3+ repetitions of one char from @ # % $ ~ ^ = +. The EXACT run from the first header is the call's delimiter on every line; a content line that equals it splits the block — escalate to a longer run (####) for the whole call (then "@@@" stays content).
- Empty old block → insert, empty new block → delete, otherwise → replace. "NNN+ @@@" is inserts only; a replace anchors its matched block itself. A hunk whose old block equals its new block is skipped with a note.

Matching (per hunk, against the ORIGINAL file content): exact block match, then trimmed lines, then whitespace-collapsed lines. Searched first within ±20 lines of NNN, then the whole file. The match nearest to NNN wins, where the distance is measured to the matched RANGE (a hint inside the block means distance 0). Two matches at the same distance → the patch is rejected as ambiguous; distinct candidates are listed in the report. Every hunk of one call is matched against that same original text: the out-numbers of an earlier hunk of the same call are NOT valid hints for a later one, they are for a follow-up call. All hunks must match; overlapping hunks are rejected; the whole edit is atomic — on any failure the batch is rejected as a whole and the report states the fate of every hunk (nothing is written).

The report tells you how each hunk matched, e.g. "replace src 69-72 → out 69-73 (4 → 5 lines), exact match, hint 20 off by 49 [LOW CONFIDENCE: matched outside the ±20 line window]": src = line numbers in the original file, out = in the resulting file. A hunk whose anchor was off gets a "note:" line above the per-hunk reports, naming both the hint and the src lines it matched; "also matches at lines …" warns about identical snippets elsewhere; "indentation: …" warns that the inserted lines use a different indent style than the file. The last line may also point out a shorter form ("NNN+ @@@") when an insert was written as a replace.

A hunk whose old block exactly equals its new block (no-op) is skipped with a note; the rest of the batch applies.

Concatenate multiple hunks in one patch. Example — change line 42, then insert after line 120:

42 @@@
const timeout = 1000
@@@
const timeout = 5000
@@@
120+ @@@
@@@
export const maxRetries = 3
@@@

Returns a per-hunk summary (line ranges, old→new line counts) and a unified diff.`;

const PARAMETERS = Type.Object({
	path: Type.String({ description: "Path to the file (relative to cwd or absolute)" }),
	patch: Type.String({ description: "One or more edit blocks (see tool description for the format)" }),
});

interface ReadResult {
	raw: string;
	crlf: boolean;
	finalNewline: boolean;
	lines: string[];
}

function readLines(absPath: string): ReadResult {
	const raw = readFileSync(absPath, "utf8");
	const crlf = raw.includes("\r\n");
	const finalNewline = raw.endsWith("\n");
	let body = raw;
	if (finalNewline) body = body.slice(0, -1); // strips "\n"; a trailing "\r" is removed per-line below
	const lines = body.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
	return { raw, crlf, finalNewline, lines };
}

function serializeLines(lines: string[], crlf: boolean, finalNewline: boolean): string {
	const sep = crlf ? "\r\n" : "\n";
	let out = lines.join(sep);
	if (finalNewline && out.length > 0) out += sep;
	return out;
}

export default function editFileExtension(pi: { registerTool: (t: unknown) => void }) {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Edit File",
		description: DESCRIPTION,
		parameters: PARAMETERS,

		async execute(_toolCallId: string, params: { path: string; patch: string }, _signal: unknown, _onUpdate: unknown, ctx: { cwd?: string }) {
			const cwd = ctx?.cwd ?? process.cwd();
			const absPath = isAbsolute(params.path) ? params.path : resolve(cwd, params.path);

			let st;
			try {
				st = statSync(absPath);
			} catch {
				throw new EditError(`file not found: ${params.path}`);
			}
			if (!st.isFile()) throw new EditError(`not a regular file: ${params.path}`);
			if (st.size > MAX_FILE_BYTES) {
				throw new EditError(`file too large: ${(st.size / 1024 / 1024).toFixed(1)}MB (limit ~5MB) — use bash for bulk edits`);
			}

			let parsed: Hunk[];
			try {
				parsed = parsePatch(params.patch);
			} catch (err) {
				if (err instanceof EditError) {
					// Grammar failures get a ready-to-paste skeleton built from the
					// model's own blocks: a patch that opens with content (the chain
					// form) and the two "delimiter missing" cases. The unified-diff
					// and delimiter-mismatch messages already carry their own
					// corrected snippet, so they are left alone.
					//
					// A skeleton needs at least one full-line delimiter to split the
					// blocks on. Without one (only "NNN @@@" headers, no standalone
					// delimiter line) its fallback text is the generic "no delimiter
					// found" — then the precise diagnosis alone is more useful.
					const grammarError = err.code === "content-start" || err.code === "missing-separator" || err.code === "unterminated";
					if (grammarError && (err.code === "content-start" || patchDelimiter(params.patch) !== null)) {
						const skeleton = chainSkeleton(params.patch, readLines(absPath).lines);
						const diagnosis = err.code === "content-start" ? "" : `${err.message}\n\n`;
						throw new EditError(`patch rejected — nothing was written to the file.\n${diagnosis}${skeleton}`);
					}
					throw new EditError(`patch rejected — nothing was written to the file.\n${err.message}`);
				}
				throw err;
			}

			// No-op hunks (before == after, exact) are skipped with a note instead
			// of killing the batch or silently doing busywork.
			const active: Array<{ hunk: Hunk; origIndex: number }> = [];
			const noOpNotes: string[] = [];
			parsed.forEach((h, i) => {
				if (isNoOpHunk(h)) noOpNotes.push(`hunk ${i + 1}: no-op (before == after) — skipped`);
				else active.push({ hunk: h, origIndex: i });
			});
			if (active.length === 0) {
				const text = `${noOpNotes.join("\n")}\nnothing to change (all hunks are no-ops)\nfile: ${params.path} — untouched`;
				return { content: [{ type: "text", text }], details: { path: absPath, hunks: [], reportLines: noOpNotes, totalLines: (readLines(absPath).lines.length), diff: "", diffTruncated: false } };
			}
			parsed = active.map((x) => x.hunk);
			const hunkNumbers = active.map((x) => x.origIndex);

			const result = await withFileMutationQueue(absPath, async () => {
				const file = readLines(absPath);
				const originalCount = file.lines.length;

				const resolved = resolveHunks(parsed, file.lines);
				const updated = applyHunks(file.lines, resolved);

				writeFileSync(absPath, serializeLines(updated, file.crlf, file.finalNewline), "utf8");

				const reports = resolved.map((r, i) => hunkSummary(r, i));
				// Caveats and the shorter-form tip go ABOVE the per-hunk lines: stale
				// anchors, batch numbering and an insert written as a replace are the
				// parts a model must not skim past.
				const tip = insertTip(resolved, hunkNumbers, patchDelimiter(params.patch) ?? "@@@");
				const caveats = [...reportCaveats(resolved, hunkNumbers), ...(tip ? [tip] : [])];
				// src = line numbers in the original file, out = in the result file;
				// hunk numbers stay the patch's original numbering across no-op skips
				const reportLines = [...caveats, ...formatHunkReports(resolved, hunkNumbers)];
				const summary =
					`${[...reportLines, ...noOpNotes].join("\n")}\nsrc = original file, out = resulting file\n` +
					`follow-up edits: use the out-numbers from this report as hints — they match the file as it is now`;

				const diffText = sequentialDiffs(file.lines, resolved)
					.filter(Boolean)
					.join("\n");
				const { text: diff, truncated } = truncateDiff(diffText);

				// No raw diff in model-facing content: models started mimicking the
				// unified-diff format when writing patches (see pi-hermes-memory
				// session 2026-09-25). The UI renders details.diff; the model gets
				// the per-hunk summary only.
				const text = `${summary}\nfile: ${params.path} — now ${updated.length} lines (was ${originalCount})`;
				return { text, reports, reportLines, totalLines: updated.length, truncated, diff };
			});

			return {
				content: [{ type: "text", text: result.text }],
				details: {
					path: absPath,
					hunks: result.reports,
					reportLines: result.reportLines,
					totalLines: result.totalLines,
					diff: result.diff,
					diffTruncated: result.truncated,
				},
			};
		},

		renderCall(args: { path?: string }, theme: any) {
			let text = theme.fg("toolTitle", theme.bold("edit_file "));
			text += theme.fg("accent", args.path ?? "");
			return new Text(text, 0, 0);
		},

		renderResult(result: any, { expanded, isPartial }: { expanded: boolean; isPartial: boolean }, theme: any) {
			if (isPartial) return new Text(theme.fg("warning", "Editing..."), 0, 0);

			const details = result?.details as
				| { path?: string; hunks?: unknown[]; reportLines?: string[]; totalLines?: number; diff?: string; diffTruncated?: boolean }
				| undefined;
			const diff = details?.diff ?? "";
			const diffLines = diff ? diff.split("\n") : [];
			let additions = 0;
			let removals = 0;
			for (const line of diffLines) {
				if (line.startsWith("+")) additions++;
				if (line.startsWith("-")) removals++;
			}

			const hunkCount = details?.hunks?.length ?? 0;
			let text = theme.fg("success", `+${additions}`);
			text += theme.fg("dim", " / ");
			text += theme.fg("error", `-${removals}`);
			text += theme.fg("dim", ` · ${hunkCount} hunk${hunkCount === 1 ? "" : "s"}`);
			if (details?.diffTruncated) text += theme.fg("warning", " [truncated]");

			// Diff развёрнут по умолчанию (решение Ника); expanded от UI игнорируем.
			// The per-hunk report lines (caveats, src/out mapping, shorter-form tip)
			// are deliberately NOT drawn: they are written for the model, and in the
			// transcript they are noise next to the diff (Nik, 2026-10-01 — "только
			// сам дифф"). details.reportLines keeps them for exports and debugging.
			if (diffLines.length > 0) {
				text += `\n${renderDiffBody(diff, details?.path, theme)}`;
			}

			return new Text(text, 0, 0);
		},
	});
 
	// pi's built-in `edit` tool must not compete with edit_file, so it is
	// withdrawn: re-registering a name with exposure "hidden" is pi's way to
	// unregister it (the tool registry has no unregister). Without this the model
	// mixes `edit` and `edit_file` within a single session.
	//
	// registerTool() only validates that parameters is an object schema, so the
	// hidden stub needs no name/description/execute of its own.
	pi.registerTool({
		name: BUILTIN_EDIT_TOOL,
		exposure: "hidden",
		parameters: Type.Object({}),
	});

	// Plugin-provided quick_edit / target_edit are deliberately left alone
	// (Nik's decision, 2026-09-26): they stay as a fallback edit path.
	registerWriteDiff(pi);
}

const WRITE_TOOL_NAME = "write";

/** Old text of a file worth diffing: regular, text, within the size cap. */
function readDiffableText(absPath: string): string | undefined {
	try {
		const st = statSync(absPath);
		if (!st.isFile() || st.size > MAX_FILE_BYTES) return undefined;
		const raw = readFileSync(absPath, "utf8");
		return raw.includes("\0") ? undefined : raw;
	} catch {
		return undefined; // new file — nothing to diff against
	}
}

/**
 * Wrap the built-in `write` tool so overwriting an existing file shows a diff.
 *
 * Pi's write returns only "Successfully wrote to <path>"; the old content is
 * captured before execution and a unified diff is attached as `details.diff`,
 * which renderResult draws in the same style as edit_file. The model-facing
 * content stays the original one-liner on purpose: models that see raw diffs in
 * tool output start imitating the format in their edits.
 */
function registerWriteDiff(pi: { registerTool: (t: unknown) => void }) {
	// createWriteTool() wraps the definition and DROPS renderCall/renderResult, so
	// the built-in content preview would be lost. createWriteToolDefinition() is the
	// unwrapped one and keeps them (…writeRenderers), which is what we delegate to.
	const schemaSource = createWriteToolDefinition(process.cwd());

	pi.registerTool({
		...schemaSource,
		name: WRITE_TOOL_NAME,

		async execute(
			toolCallId: string,
			params: { path: string; content: string },
			signal: unknown,
			onUpdate: unknown,
			ctx: { cwd?: string },
		) {
			const cwd = ctx?.cwd ?? process.cwd();
			const absPath = isAbsolute(params.path) ? params.path : resolve(cwd, params.path);
			const before = readDiffableText(absPath);

			// Fresh instance so relative paths resolve against this session's cwd.
			const result = await createWriteToolDefinition(cwd).execute(toolCallId, params, signal, onUpdate, ctx);
			if (before === undefined || before === params.content) return result;

			const diffText = unifiedDiff(before, params.content, params.path);
			if (!diffText) return result;
			const { text: diff, truncated } = truncateDiff(diffText);

			return {
				...(result as Record<string, unknown>),
				details: { path: absPath, diff, diffTruncated: truncated },
			};
		},

		// Delegate the call rendering to pi's built-in renderer: it already shows
		// the content preview (first 10 lines, syntax-highlighted) plus
		// "... (N more lines, M total, …)". Only the diff case is ours.
		renderCall(args: unknown, theme: any, context: any) {
			const original = (schemaSource as { renderCall?: (a: unknown, t: unknown, c: unknown) => unknown }).renderCall;
			const component = typeof original === "function"
				? original(args, theme, context)
				: new Text(
					`${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", (args as { path?: string } | undefined)?.path ?? "")}`,
					0,
					0,
				);
			// Stash it: an overwrite replaces this call region (the content preview)
			// with the diff, so the unchanged first lines are not repeated below.
			if (context?.state) (context.state as { callComponent?: unknown }).callComponent = component;
			return component;
		},

		renderResult(result: any, options: { expanded: boolean; isPartial: boolean }, theme: any, context: any) {
			const details = result?.details as { diff?: string; diffTruncated?: boolean } | undefined;
			const diff = details?.diff ?? "";
			if (!diff) {
				// New file or no-op: keep pi's own result rendering (it clears the
				// call component on success, so the preview stays as-is).
				const original = (schemaSource as { renderResult?: (...a: any[]) => unknown }).renderResult;
				if (typeof original === "function") return original(result, options, theme, context);
				const text = (result?.content ?? [])
					.filter((c: any) => c?.type === "text")
					.map((c: any) => c.text ?? "")
					.join("\n");
				return new Text(theme.fg("dim", text || "written"), 0, 0);
			}

			const lines = diff.split("\n");
			let additions = 0;
			let removals = 0;
			for (const line of lines) {
				if (line.startsWith("+++") || line.startsWith("---")) continue;
				if (line.startsWith("+")) additions++;
				if (line.startsWith("-")) removals++;
			}

			let text = theme.fg("success", `+${additions}`);
			text += theme.fg("dim", " / ");
			text += theme.fg("error", `-${removals}`);
			text += theme.fg("dim", " · overwrite");
			if (details?.diffTruncated) text += theme.fg("warning", " [truncated]");

			text += `\n${renderDiffBody(diff, details?.path, theme)}`;

			// Overwrite: show header + summary + diff INSTEAD of the content preview
			// (pi renders the call region separately, so returning a new component
			// would leave the preview above the diff).
			const state = context?.state as { callComponent?: { setText?: (t: string) => void } } | undefined;
			const callComponent = state?.callComponent;
			if (callComponent && typeof callComponent.setText === "function" && context?.args) {
				const path = (context.args as { path?: string }).path ?? "";
				const header = `${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", path)}`;
				callComponent.setText(`${header}\n${text}`);
				const empty = context.lastComponent ?? new Text("", 0, 0);
				if (typeof (empty as { clear?: () => void }).clear === "function") (empty as { clear: () => void }).clear();
				return empty;
			}

			return new Text(text, 0, 0);
		},
	});
 }

/**
 * Diff line backgrounds: flat pastel tints, no theme blending.
 *
 * Removed lines get #ffd7d7, added lines #d7ffd7 — picked for the light
 * "light-fix" theme. The earlier implementation derived the tint from the
 * theme's own diff colors (blended toward white on light themes, black on dark
 * ones, with a PI_DIFF_BG_DIM knob); that is gone on purpose, so the diff looks
 * the same in every session and nothing depends on the theme's palette.
 */
const DIFF_BG_REMOVED = "\x1B[48;2;255;215;215m"; // #ffd7d7
const DIFF_BG_ADDED = "\x1B[48;2;215;255;215m"; // #d7ffd7

/**
 * Render a unified diff body with syntax highlighting.
 *
 * Hybrid approach: the NEW file is read from disk and highlighted as a whole, so
 * added and context lines keep multi-line context (template literals, block
 * comments); removed lines no longer exist on disk and are highlighted
 * individually.
 *
 * Coloring is line-level only: removed lines get the red tint, added lines the
 * green one (see DIFF_BG_*). Word-level highlighting was removed on purpose —
 * the tint plus syntax colors already say what changed, and inverting tokens
 * fought with the syntax highlighting underneath. Marker characters and hunk
 * headers keep the theme's diff colors; the code itself is never re-wrapped in
 * fg(), which would wipe the colors highlightCode already applied.
 */
function renderDiffBody(diffText: string, absPath: string | undefined, theme: any): string {
	const hunks = parseUnifiedDiff(diffText);
	if (hunks.length === 0) return diffText;

	const lang = absPath ? getLanguageFromPath(absPath) : undefined;
	let newFileLines: string[] | undefined;
	if (lang && absPath) {
		try {
			newFileLines = highlightCode(readFileSync(absPath, "utf8"), lang);
		} catch {
			newFileLines = undefined; // file removed/renamed since the edit: fall back
		}
	}

	const hl = (text: string): string => {
		if (!lang) return text;
		try {
			return highlightCode(text, lang)[0] ?? text;
		} catch {
			return text;
		}
	};
	const newLine = (text: string, b: number): string => newFileLines?.[b - 1] ?? hl(text);

	const shade = (bg: string, text: string): string => `${bg}${text}\x1B[49m`;

	const out: string[] = [];
	for (const hunk of hunks) {
		out.push(theme.fg("accent", hunk.header));
		const lines = hunk.lines;
		let b = hunk.bStart;
		let i = 0;

		while (i < lines.length) {
			if (lines[i].kind === " ") {
				out.push(` ${newLine(lines[i].text, b)}`);
				b++;
				i++;
				continue;
			}

			if (lines[i].kind === "-") {
				const removed: string[] = [];
				while (i < lines.length && lines[i].kind === "-") removed.push(lines[i++].text);
				const added: string[] = [];
				while (i < lines.length && lines[i].kind === "+") added.push(lines[i++].text);

				for (const text of removed) out.push(shade(DIFF_BG_REMOVED, `${theme.fg("toolDiffRemoved", "-")}${hl(text)}`));
				for (const text of added) {
					out.push(shade(DIFF_BG_ADDED, `${theme.fg("toolDiffAdded", "+")}${newLine(text, b)}`));
					b++;
				}
				continue;
			}

			// Pure insertion (no preceding removals in this run).
			while (i < lines.length && lines[i].kind === "+") {
				out.push(shade(DIFF_BG_ADDED, `${theme.fg("toolDiffAdded", "+")}${newLine(lines[i].text, b)}`));
				b++;
				i++;
			}
		}
	}

	return out.join("\n");
}
