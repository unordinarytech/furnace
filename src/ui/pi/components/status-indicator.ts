/**
 * Ported from pi (https://github.com/earendil-works/pi).
 * MIT License, Copyright (c) 2025 Mario Zechner.
 */
import { type Component, Loader, type TUI } from "@earendil-works/pi-tui";
import { theme } from "../theme.js";

/**
 * Working indicator configuration for the interactive streaming loader.
 * Local structural equivalent of pi's `WorkingIndicatorOptions` from core/extensions.
 */
export interface WorkingIndicatorOptions {
	/** Animation frames. Use an empty array to hide the indicator entirely. Custom frames are rendered verbatim. */
	frames?: string[];
	/** Frame interval in milliseconds for animated indicators. */
	intervalMs?: number;
}

export type StatusIndicatorKind = "working";

export class StatusIndicator extends Loader {
	readonly kind: StatusIndicatorKind;

	constructor(
		kind: StatusIndicatorKind,
		ui: TUI,
		spinnerColorFn: (str: string) => string,
		messageColorFn: (str: string) => string,
		message: string,
		indicator?: WorkingIndicatorOptions,
	) {
		super(ui, spinnerColorFn, messageColorFn, message, indicator);
		this.kind = kind;
	}

	dispose(): void {
		this.stop();
	}
}

export class WorkingStatusIndicator extends StatusIndicator {
	constructor(ui: TUI, message: string, indicator?: WorkingIndicatorOptions) {
		super(
			"working",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			message,
			indicator,
		);
	}
}

export class IdleStatus implements Component {
	invalidate(): void {
		// No cached state to invalidate.
	}

	render(width: number): string[] {
		const emptyLine = " ".repeat(width);
		return [emptyLine, emptyLine];
	}
}
