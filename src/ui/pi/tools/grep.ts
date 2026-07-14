/**
 * Ported from pi (https://github.com/earendil-works/pi).
 * MIT License, Copyright (c) 2025 Mario Zechner.
 *
 * Render-only port of pi's grep tool definition: execute() (ripgrep backend)
 * is omitted; all rendering logic is kept verbatim.
 */
import { Text } from "@earendil-works/pi-tui";
import { keyHint } from "../components/keybinding-hints.js";
import type { Theme } from "../theme.js";
import type { ToolDefinition, ToolRenderResultOptions } from "./types.js";
import { getTextOutput, invalidArgText, shortenPath, str } from "../render-utils.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult } from "../truncate.js";

export type GrepToolInput = {
	pattern: string;
	path?: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	context?: number;
	limit?: number;
	maxResults?: number;
	regex?: boolean;
};

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
}

function formatGrepCall(
	args: { pattern: string; path?: string; glob?: string; limit?: number; maxResults?: number; regex?: boolean } | undefined,
	theme: Theme,
): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const glob = str(args?.glob);
	const limit = args?.maxResults ?? args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("grep")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", args?.regex === false ? pattern || "" : `/${pattern || ""}/`)) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (glob) text += theme.fg("toolOutput", ` (${glob})`);
	if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${limit}`);
	return text;
}

function formatGrepResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: GrepToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 15;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	const matchLimit = result.details?.matchLimitReached;
	const truncation = result.details?.truncation;
	const linesTruncated = result.details?.linesTruncated;
	if (matchLimit || truncation?.truncated || linesTruncated) {
		const warnings: string[] = [];
		if (matchLimit) warnings.push(`${matchLimit} matches limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		if (linesTruncated) warnings.push("some lines truncated");
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export function createGrepToolDefinition(_cwd: string): ToolDefinition<GrepToolInput, GrepToolDetails | undefined> {
	return {
		name: "grep",
		label: "grep",
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}
