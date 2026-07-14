/**
 * Ported from pi (https://github.com/earendil-works/pi).
 * MIT License, Copyright (c) 2025 Mario Zechner.
 *
 * Render-only port of pi's find tool definition: execute() (fd backend) is
 * omitted; all rendering logic is kept verbatim.
 */
import { Text } from "@earendil-works/pi-tui";
import { keyHint } from "../components/keybinding-hints.js";
import type { Theme } from "../theme.js";
import type { ToolDefinition, ToolRenderResultOptions } from "./types.js";
import { getTextOutput, invalidArgText, shortenPath, str } from "../render-utils.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult } from "../truncate.js";

export type FindToolInput = { pattern?: string; query?: string; path?: string; limit?: number; maxResults?: number };

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
}

function formatFindCall(args: FindToolInput | undefined, theme: Theme): string {
	const pattern = str(args?.query ?? args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const limit = args?.maxResults ?? args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("find")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", pattern || "")) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
	return text;
}

function formatFindResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: FindToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 20;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	const resultLimit = result.details?.resultLimitReached;
	const truncation = result.details?.truncation;
	if (resultLimit || truncation?.truncated) {
		const warnings: string[] = [];
		if (resultLimit) warnings.push(`${resultLimit} results limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export function createFindToolDefinition(_cwd: string): ToolDefinition<FindToolInput, FindToolDetails | undefined> {
	return {
		name: "find",
		label: "find",
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatFindCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatFindResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}
