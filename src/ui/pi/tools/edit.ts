/**
 * Ported from pi (https://github.com/earendil-works/pi).
 * MIT License, Copyright (c) 2025 Mario Zechner.
 *
 * Render-only port of pi's edit tool definition: execute() is omitted;
 * all rendering logic (including the live diff preview) is kept verbatim.
 */
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { renderDiff } from "../components/diff.js";
import type { Theme } from "../theme.js";
import type { ToolDefinition } from "./types.js";
import { computeEditsDiff, type Edit, type EditDiffError, type EditDiffResult } from "./edit-diff.js";
import { renderToolPath, str } from "../render-utils.js";
import { parsePatchEnvelope } from "../../../tools/patch.js";

type EditPreview = EditDiffResult | EditDiffError;

type EditRenderState = {
	callComponent?: EditCallRenderComponent;
};

export type EditToolInput = { path: string; edits: Edit[] };
type LegacyEditToolInput = EditToolInput & {
	oldText?: unknown;
	newText?: unknown;
};

export interface EditToolDetails {
	/** Display-oriented diff of the changes made */
	diff: string;
	/** Standard unified patch of the changes made */
	patch: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
}

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") {
		return input as EditToolInput;
	}

	const args = input as Record<string, unknown>;

	// Some models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of an array
	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);
			if (Array.isArray(parsed)) args.edits = parsed;
		} catch {}
	}

	const legacy = args as LegacyEditToolInput;
	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
		return args as EditToolInput;
	}

	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	return { ...rest, edits } as EditToolInput;
}

type RenderableEditArgs = {
	path?: string;
	file_path?: string;
	edits?: Edit[];
	oldText?: string;
	newText?: string;
	patch?: string;
};

type EditToolResultLike = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: EditToolDetails;
};

type EditCallRenderComponent = Box & {
	preview?: EditPreview;
	previewArgsKey?: string;
	previewPending?: boolean;
	settledError?: boolean;
};

function createEditCallRenderComponent(): EditCallRenderComponent {
	return Object.assign(new Box(1, 1, (text: string) => text), {
		preview: undefined as EditPreview | undefined,
		previewArgsKey: undefined as string | undefined,
		previewPending: false,
		settledError: false,
	});
}

function getEditCallRenderComponent(state: EditRenderState, lastComponent: unknown): EditCallRenderComponent {
	if (lastComponent instanceof Box) {
		const component = lastComponent as EditCallRenderComponent;
		state.callComponent = component;
		return component;
	}
	if (state.callComponent) {
		return state.callComponent;
	}
	const component = createEditCallRenderComponent();
	state.callComponent = component;
	return component;
}

function getRenderablePreviewInput(args: RenderableEditArgs | undefined): { path: string; edits: Edit[] } | null {
	if (!args) {
		return null;
	}

	const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
	if (!path) {
		return null;
	}

	if (
		Array.isArray(args.edits) &&
		args.edits.length > 0 &&
		args.edits.every((edit) => typeof edit?.oldText === "string" && typeof edit?.newText === "string")
	) {
		return { path, edits: args.edits };
	}

	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		return { path, edits: [{ oldText: args.oldText, newText: args.newText }] };
	}

	return null;
}

function furnacePatchPreview(patch: string): EditPreview {
	try {
		const parsed = parsePatchEnvelope(patch);
		const lines = parsed.operations.flatMap((operation) => {
			if (operation.operation === "add") {
				return [
					`File: ${operation.path} (new)`,
					...operation.contentLines.map((line) => `+  ${line}`),
				];
			}
			if (operation.operation === "delete") {
				return [`File: ${operation.path} (deleted)`];
			}
			return [
				`File: ${operation.path}`,
				...operation.hunks.flatMap((hunk) => [
					...hunk.oldLines.map((line) => `-  ${line}`),
					...hunk.newLines.map((line) => `+  ${line}`),
				]),
			];
		});
		const maxLines = 60;
		const previewLines = lines.length > maxLines
			? [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more changed lines`]
			: lines;
		return { diff: previewLines.join("\n"), firstChangedLine: undefined };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function formatEditCall(args: RenderableEditArgs | undefined, theme: Theme, cwd: string): string {
	if (typeof args?.patch === "string") {
		try {
			const targets = parsePatchEnvelope(args.patch).targets.map((target) => target.path).join(", ");
			return `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("toolOutput", targets || "patch")}`;
		} catch {
			return `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("toolOutput", "patch")}`;
		}
	}
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme, cwd);
	return `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;
}

function formatEditResult(
	args: RenderableEditArgs | undefined,
	preview: EditPreview | undefined,
	result: EditToolResultLike,
	theme: Theme,
	isError: boolean,
): string | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	const previewDiff = preview && !("error" in preview) ? preview.diff : undefined;
	const previewError = preview && "error" in preview ? preview.error : undefined;
	if (isError) {
		const errorText = result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("\n");
		if (!errorText || errorText === previewError) {
			return undefined;
		}
		return theme.fg("error", errorText);
	}

	const resultDiff = result.details?.diff;
	if (resultDiff && resultDiff !== previewDiff) {
		return renderDiff(resultDiff, { filePath: rawPath ?? undefined });
	}

	return undefined;
}

function getEditHeaderBg(
	preview: EditPreview | undefined,
	settledError: boolean | undefined,
	theme: Theme,
): (text: string) => string {
	if (preview) {
		if ("error" in preview) {
			return (text: string) => theme.bg("toolErrorBg", text);
		}
		return (text: string) => theme.bg("toolSuccessBg", text);
	}
	if (settledError) {
		return (text: string) => theme.bg("toolErrorBg", text);
	}
	return (text: string) => theme.bg("toolPendingBg", text);
}

function buildEditCallComponent(
	component: EditCallRenderComponent,
	args: RenderableEditArgs | undefined,
	theme: Theme,
	cwd: string,
): EditCallRenderComponent {
	component.setBgFn(getEditHeaderBg(component.preview, component.settledError, theme));
	component.clear();
	component.addChild(new Text(formatEditCall(args, theme, cwd), 0, 0));

	if (!component.preview) {
		return component;
	}

	const body =
		"error" in component.preview ? theme.fg("error", component.preview.error) : renderDiff(component.preview.diff);
	component.addChild(new Spacer(1));
	component.addChild(new Text(body, 0, 0));
	return component;
}

function setEditPreview(
	component: EditCallRenderComponent,
	preview: EditPreview,
	argsKey: string | undefined,
): boolean {
	const current = component.preview;
	const changed =
		current === undefined ||
		("error" in current && "error" in preview
			? current.error !== preview.error
			: "error" in current !== "error" in preview) ||
		(!("error" in current) &&
			!("error" in preview) &&
			(current.diff !== preview.diff || current.firstChangedLine !== preview.firstChangedLine));
	component.preview = preview;
	component.previewArgsKey = argsKey;
	component.previewPending = false;
	return changed;
}

export function createEditToolDefinition(
	_cwd: string,
): ToolDefinition<RenderableEditArgs, EditToolDetails | undefined, EditRenderState> {
	return {
		name: "edit",
		label: "edit",
		renderShell: "self",
		prepareArguments: prepareEditArguments,
		renderCall(args, theme, context) {
			const component = getEditCallRenderComponent(context.state, context.lastComponent);
			const furnacePatch = typeof args?.patch === "string" ? args.patch : undefined;
			const previewInput = getRenderablePreviewInput(args as RenderableEditArgs | undefined);
			const argsKey = furnacePatch ?? (previewInput
				? JSON.stringify({ path: previewInput.path, edits: previewInput.edits })
				: undefined);

			if (component.previewArgsKey !== argsKey) {
				component.preview = undefined;
				component.previewArgsKey = argsKey;
				component.previewPending = false;
				component.settledError = false;
			}

			if (context.argsComplete && furnacePatch && !component.preview) {
				setEditPreview(component, furnacePatchPreview(furnacePatch), argsKey);
			} else if (context.argsComplete && previewInput && !component.preview && !component.previewPending) {
				component.previewPending = true;
				const requestKey = argsKey;
				void computeEditsDiff(previewInput.path, previewInput.edits, context.cwd).then((preview) => {
					if (component.previewArgsKey === requestKey) {
						setEditPreview(component, preview, requestKey);
						context.invalidate();
					}
				});
			}

			return buildEditCallComponent(component, args, theme, context.cwd);
		},
		renderResult(result, _options, theme, context) {
			const callComponent = context.state.callComponent;
			const previewInput = getRenderablePreviewInput(context.args as RenderableEditArgs | undefined);
			const argsKey = previewInput
				? JSON.stringify({ path: previewInput.path, edits: previewInput.edits })
				: undefined;
			const typedResult = result as EditToolResultLike;
			const resultDiff = !context.isError ? typedResult.details?.diff : undefined;
			let changed = false;
			if (callComponent) {
				if (typeof resultDiff === "string") {
					changed =
						setEditPreview(
							callComponent,
							{ diff: resultDiff, firstChangedLine: typedResult.details?.firstChangedLine },
							argsKey,
						) || changed;
				}
				if (callComponent.settledError !== context.isError) {
					callComponent.settledError = context.isError;
					changed = true;
				}
				if (changed) {
					buildEditCallComponent(
						callComponent,
						context.args as RenderableEditArgs | undefined,
						theme,
						context.cwd,
					);
				}
			}

			const output = formatEditResult(context.args, callComponent?.preview, typedResult, theme, context.isError);
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			if (!output) {
				return component;
			}
			component.addChild(new Spacer(1));
			component.addChild(new Text(output, 1, 0));
			return component;
		},
	};
}
