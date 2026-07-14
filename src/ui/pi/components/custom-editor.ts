/**
 * Ported from pi (https://github.com/earendil-works/pi).
 * MIT License, Copyright (c) 2025 Mario Zechner.
 */
import { Editor, type EditorOptions, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../keybindings.js";

const CHAT_INPUT_MIN_CONTENT_LINES = 5;

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private inputDisabled = false;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	public onPasteMarkerBackspace?: (actions: {
		deletePaste: () => void;
		editPaste: () => void;
	}) => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
	}

	/**
	 * Override render to ensure the chat input always shows at least
	 * CHAT_INPUT_MIN_CONTENT_LINES content lines, expanding the editor
	 * area so there's visible breathing room even when the input is empty.
	 *
	 * The base Editor render output has this shape:
	 *   [0]      top border  (─────…)
	 *   [1..N]   content lines  (N ≥ 1)
	 *   [N+1]    bottom border (─────…)
	 *
	 * We splice blank padding lines before the bottom border so the total
	 * content-line count reaches the minimum.  LayoutEditorFrame strips the
	 * border lines by pattern-matching /^─+$/, so only the extra blanks flow
	 * through into the framed area — exactly what we want.
	 */
	override render(width: number): string[] {
		const lines = super.render(width);
		// The base render guarantees at least 3 lines (top border, 1 content, bottom border).
		if (lines.length < 3) return lines;

		const topBorder = lines[0]!;
		const bottomBorder = lines[lines.length - 1]!;
		const contentLines = lines.slice(1, lines.length - 1);

		const deficit = CHAT_INPUT_MIN_CONTENT_LINES - contentLines.length;
		if (deficit <= 0) return lines;

		// Build a blank line that matches the width of the content lines.
		const blankLine = " ".repeat(width);
		const padding = Array.from({ length: deficit }, () => blankLine);

		return [topBorder, ...contentLines, ...padding, bottomBorder];
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	setInputDisabled(disabled: boolean): void {
		this.inputDisabled = disabled;
	}

	handleInput(data: string): void {
		if (this.inputDisabled) {
			if (this.keybindings.matches(data, "app.interrupt")) {
				(this.onEscape ?? this.actionHandlers.get("app.interrupt"))?.();
			} else if (this.keybindings.matches(data, "app.clear")) {
				this.actionHandlers.get("app.clear")?.();
			}
			return;
		}

		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		if (
			(this.keybindings.matches(data, "tui.editor.deleteCharBackward") || data === "\x7f")
			&& this.hasPasteMarkerBeforeCursor()
			&& this.onPasteMarkerBackspace
		) {
			this.onPasteMarkerBackspace({
				deletePaste: () => super.handleInput(data),
				editPaste: () => this.setText(this.getExpandedText()),
			});
			return;
		}

		// Check for paste image keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}

	private hasPasteMarkerBeforeCursor(): boolean {
		const { line, col } = this.getCursor();
		const currentLine = this.getLines()[line] ?? "";
		return /\[paste #\d+(?: (?:\+\d+ lines|\d+ chars))?\]$/.test(currentLine.slice(0, col));
	}
}
