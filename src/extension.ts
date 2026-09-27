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
 * Also overrides the built-in `write` tool: overwriting an existing file renders
 * the same diff (per-line syntax highlighting, word-level emphasis, line
 * backgrounds) instead of the content preview.
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
	formatHunkReports,
	hunkSummary,
	applyHunks,
	parsePatch,
	resolveHunks,
	sequentialDiffs,
	truncateDiff,
	parseUnifiedDiff,
	wordDiffPair,
} from "./core.ts";

const TOOL_NAME = "edit_file";

const DESCRIPTION = `Edit a file using one or more block patches passed as a single 'patch' string. Each hunk:

NNN @@@
old line 1
old line 2
@@@
new line 1
new line 2
@@@

- NNN: 1-based line number where the old block starts (anchor hint, not strict). It may be omitted entirely — write a bare "@@@" line as the header and the block must then match exactly once in the file (an insert still needs NNN, since it has no block to match).
- The patch is a JSON string: one patch line is one file line. Never type "\\n" yourself — write real line breaks. Backticks, \${...} and quotes need no escaping.
- @@@: delimiter, 3+ repetitions of one char from @ # % $ ~ ^ = +. Use the same delimiter character throughout the call; if the file content contains a line like @@@, escalate to a longer run (####) for the whole call.
- Empty old block → insert new lines before line NNN (append at end of file if NNN is past the last line).
- Empty new block → delete the old block.
- Otherwise → replace the matched old block with the new block.

Matching (per hunk, against the ORIGINAL file content): exact block match, then trimmed lines, then whitespace-collapsed lines. Searched first within ±20 lines of NNN, then the whole file. The match nearest to NNN wins, where the distance is measured to the matched RANGE (a hint inside the block means distance 0). Two matches at the same distance → the patch is rejected as ambiguous; distinct candidates are listed in the report. All hunks must match; overlapping hunks are rejected; the whole edit is atomic — on any failure the batch is rejected as a whole and the report states the fate of every hunk (nothing is written).

The report also tells you how each hunk matched, e.g. "replace src 69-72 → out 69-73 (4 → 5 lines), exact match, hint 20 off by 49 [LOW CONFIDENCE: matched outside the ±20 line window]": src = line numbers in the original file, out = in the resulting file. "also matches at lines …" warns about identical snippets elsewhere, "indentation: …" warns that the inserted lines use a different indent style than the file.

Concatenate multiple hunks in one patch. Example — change line 42 and append after line 120:

42 @@@
const timeout = 1000
@@@
const timeout = 5000
@@@
120 @@@
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
					throw new EditError(`patch rejected — nothing was written to the file.\n${err.message}`);
				}
				throw err;
			}

			const result = await withFileMutationQueue(absPath, async () => {
				const file = readLines(absPath);
				const originalCount = file.lines.length;

				const resolved = resolveHunks(parsed, file.lines);
				const updated = applyHunks(file.lines, resolved);

				writeFileSync(absPath, serializeLines(updated, file.crlf, file.finalNewline), "utf8");

				const reports = resolved.map((r, i) => hunkSummary(r, i));
				// src = line numbers in the original file, out = in the result file
				const reportLines = formatHunkReports(resolved);
				const summary = `${reportLines.join("\n")}\nsrc = original file, out = resulting file`;

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
			if (diffLines.length > 0) {
				text += `\n${renderDiffBody(diff, details?.path, theme)}`;
				// Same wording as the model-facing report (src = original file,
				// out = resulting file), so the transcript and the tool agree.
				for (const line of details?.reportLines ?? []) {
					text += `\n${theme.fg("dim", line)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});
 
	// quick_edit / target_edit are NOT built-in pi tools — they are plugin-provided
	// and are intentionally kept active as a fallback (Nik's decision, 2026-09-26),
	// so edit_file no longer deactivates anything. It just has to be the tool the
	// model reaches for first; the per-hunk summary and precise match diagnostics
	// keep the two edit paths from being confused.
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
 * Background tint for a diff line, derived from the theme's own diff color.
 *
 * Built-in themes define no `backgrounds` section, so theme.bg() would throw;
 * instead we take the foreground ANSI escape (truecolor after var resolution) and
 * dim it into a dark tint, which keeps the syntax-highlighted code readable on
 * top. On 256-color terminals we fall back to a fixed dark shade of the same hue.
 * Returns undefined when the color cannot be resolved (then lines stay unshaded).
 */
/** Tint strength for diff line backgrounds (see diffLineBackground). */
function diffBackgroundMix(light: boolean): number {
	const raw = Number(process.env.PI_DIFF_BG_DIM);
	if (Number.isFinite(raw) && raw > 0 && raw <= 1) return raw;
	return light ? 0.38 : 0.45;
}

/**
 * Does the active theme sit on a light background? The theme's TEXT color is the
 * reliable signal: light themes use dark text (#1f2328) and dark themes light
 * text (#d4d4d4). `theme.mode` is used when present, the luminance heuristic
 * covers custom themes (e.g. "light-fix").
 */
function themeHasLightBackground(theme: any): boolean {
	if (theme?.mode === "light") return true;
	if (theme?.mode === "dark") return false;
	try {
		const fg = theme?.getFgAnsi?.("text");
		const tc = typeof fg === "string" ? /38;2;(\d+);(\d+);(\d+)/.exec(fg) : null;
		if (tc) {
			const [r, g, b] = [tc[1], tc[2], tc[3]].map(Number);
			return 0.299 * r + 0.587 * g + 0.114 * b < 128;
		}
	} catch {
		// unknown color key
	}
	return false;
}

function diffLineBackground(theme: any, key: string, light: boolean): string | undefined {
	try {
		const fg = theme?.getFgAnsi?.(key);
		if (typeof fg !== "string") return undefined;
		const truecolor = /38;2;(\d+);(\d+);(\d+)/.exec(fg);
		if (truecolor) {
			// Blend the theme's diff hue toward the background: white on a light
			// theme, black on a dark one. A straight "dim toward black" produced
			// near-black blocks on light terminals, hence the direction switch.
			// PI_DIFF_BG_DIM (0..1) overrides how much hue is kept.
			const mix = diffBackgroundMix(light);
			const target = light ? 255 : 0;
			const [r, g, b] = [truecolor[1], truecolor[2], truecolor[3]].map((v) =>
				Math.round(target + (Number(v) - target) * mix),
			);
			return `\x1B[48;2;${r};${g};${b}m`;
		}
		if (/38;5;\d+/.test(fg)) return `\x1B[48;5;${light ? 224 : 52}m`;
	} catch {
		// unknown color key on a custom theme: fall through, no shading
	}
	return undefined;
}

/**
 * Render a unified diff body with syntax highlighting.
 *
 * Hybrid approach: the NEW file is read from disk and highlighted as a whole, so
 * added and context lines keep multi-line context (template literals, block
 * comments); removed lines no longer exist on disk and are highlighted
 * individually. A 1:1 removed/added pair gets word-level highlighting
 * (theme.inverse), the same idea as pi's own edit diff. Marker characters and
 * hunk headers keep the theme's diff colors; the code itself is never re-wrapped
 * in fg(), which would wipe the colors highlightCode already applied.
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

	// Line background tints (see diffLineBackground): on light themes blended
	// toward white, on dark toward black. 256-color fallbacks: 224/194 light,
	// 52/22 dark.
	const lightBg = themeHasLightBackground(theme);
	const bgRemoved = diffLineBackground(theme, "toolDiffRemoved", lightBg);
	const bgAdded = diffLineBackground(theme, "toolDiffAdded", lightBg);
	const shade = (bg: string | undefined, text: string): string => (bg ? `${bg}${text}\x1B[49m` : text);

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

				if (removed.length === added.length && added.length > 0) {
					for (let k = 0; k < removed.length; k++) {
						const pair = wordDiffPair(removed[k], added[k]);
						const oldText = pair.old
							.map((s) => (s.changed ? theme.inverse(hl(s.text)) : hl(s.text)))
							.join("");
						const newText = pair.new
							.map((s) => (s.changed ? theme.inverse(hl(s.text)) : hl(s.text)))
							.join("");
						out.push(shade(bgRemoved, `${theme.fg("toolDiffRemoved", "-")}${oldText}`));
						out.push(shade(bgAdded, `${theme.fg("toolDiffAdded", "+")}${newText}`));
						b++;
					}
				} else {
					for (const text of removed) out.push(shade(bgRemoved, `${theme.fg("toolDiffRemoved", "-")}${hl(text)}`));
					for (const text of added) {
						out.push(shade(bgAdded, `${theme.fg("toolDiffAdded", "+")}${newLine(text, b)}`));
						b++;
					}
				}
				continue;
			}

			// Pure insertion (no preceding removals in this run).
			while (i < lines.length && lines[i].kind === "+") {
				out.push(shade(bgAdded, `${theme.fg("toolDiffAdded", "+")}${newLine(lines[i].text, b)}`));
				b++;
				i++;
			}
		}
	}

	return out.join("\n");
}
