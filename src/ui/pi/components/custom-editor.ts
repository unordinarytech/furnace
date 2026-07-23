/**
 * Ported from pi (https://github.com/earendil-works/pi).
 * MIT License, Copyright (c) 2025 Mario Zechner.
 */
import { Editor, type AutocompleteItem, type EditorOptions, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../keybindings.js";

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
	public onAutocompleteTab?: (item: AutocompleteItem) => boolean;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	reopenAutocomplete(selectedIndex: number): void {
		const editor = this as unknown as {
			autocompleteRequestTask?: Promise<void>;
			autocompleteList?: { setSelectedIndex(index: number): void };
			requestAutocomplete(options: { explicitTab: boolean; force: boolean }): void;
		};
		setImmediate(() => {
			editor.requestAutocomplete({ explicitTab: false, force: false });
			void Promise.resolve(editor.autocompleteRequestTask).then(() => {
				editor.autocompleteList?.setSelectedIndex(selectedIndex);
				this.tui.requestRender();
			});
		});
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

		// Fix: When Enter is pressed while autocomplete is showing, the base pi-tui
		// Editor applies the completion for slash commands and then falls through
		// to the newline/submit checks. If Enter arrives as \n, the hardcoded
		// newline check catches it before the submit check, inserting a newline
		// instead of submitting the completed command.
		//
		// We intercept here: if autocomplete is showing and Enter is pressed, let
		// the base Editor apply the completion, then submit immediately instead of
		// falling through.
		if (this.isShowingAutocomplete()) {
			if (this.keybindings.matches(data, "tui.select.confirm") || this.keybindings.matches(data, "tui.input.submit")) {
				// Let base Editor apply the completion (it handles this for slash commands)
				super.handleInput(data);
				// If autocomplete is now gone (the completion was applied), the text
				// should be a completed slash command — submit the value
				if (!this.isShowingAutocomplete()) {
					const text = this.getText().trim();
					if (text.startsWith("/") && this.onSubmit) {
						this.onSubmit(text);
					}
				}
				return;
			}
		}

		if (this.keybindings.matches(data, "tui.input.tab")) {
			const autocomplete = this as unknown as {
				autocompleteState?: unknown;
				autocompleteList?: { getSelectedItem(): AutocompleteItem | null };
				cancelAutocomplete(): void;
			};
			const selected = autocomplete.autocompleteState
				? autocomplete.autocompleteList?.getSelectedItem()
				: undefined;
			if (selected && this.onAutocompleteTab?.(selected)) {
				autocomplete.cancelAutocomplete();
				return;
			}
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
