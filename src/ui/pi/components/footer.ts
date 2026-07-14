/**
 * Ported from pi (https://github.com/earendil-works/pi).
 * MIT License, Copyright (c) 2025 Mario Zechner.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ReadonlyFooterDataProvider } from "../footer-data-provider.js";
import { theme } from "../theme.js";
import type { StatusLinePreferences } from "../../../preferences.js";

/**
 * Local structural equivalents of pi's core types (agent-session.ts / session-manager.ts).
 * The furnace side implements these to feed the footer; only the fields the footer
 * actually reads are declared here.
 */

/** Usage stats on an assistant message. Mirrors pi's `Usage`. */
export interface FooterAssistantUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
}

/** Model info the footer reads. Mirrors the relevant subset of pi's `Model`. */
export interface FooterModel {
	id: string;
	provider: string;
	contextWindow: number;
	name?: string;
	/** Truthy if the model supports reasoning/thinking. */
	reasoning?: boolean;
}

/** Session entry union, discriminated so the assistant-usage loop narrows correctly. */
export type FooterSessionEntry =
	| {
			type: "message";
			message:
				| { role: "assistant"; usage: FooterAssistantUsage }
				| { role: "user" | "system" | "toolResult" | "custom" };
	  }
	| {
			type:
				| "thinkingLevelChange"
				| "modelChange"
				| "compaction"
				| "branchSummary"
				| "custom"
				| "customMessage"
				| "label"
				| "sessionInfo";
	  };

/** Mirrors pi's `ContextUsage` (core/extensions/types.ts). */
export interface FooterContextUsage {
	/** Estimated context tokens, or null if unknown (e.g. right after compaction, before next LLM response). */
	tokens: number | null;
	contextWindow: number;
	/** Context usage as percentage of context window, or null if tokens is unknown. */
	percent: number | null;
}

/** Subset of pi's `SessionManager` used by the footer. */
export interface FooterSessionManager {
	getEntries(): FooterSessionEntry[];
	getCwd(): string;
	getSessionName(): string | undefined | null;
}

/** Subset of pi's `ModelRegistry` used by the footer. */
export interface FooterModelRegistry {
	isUsingOAuth(model: FooterModel): boolean;
}

/** Subset of pi's `AgentSession` state used by the footer. */
export interface FooterSessionState {
	model?: FooterModel;
	thinkingLevel?: string;
	fast?: boolean;
	mode?: "agent" | "plan";
	configuredContextWindow?: number;
	themeName?: string;
	forkParentTitle?: string;
}

/** Structural equivalent of pi's `AgentSession` as consumed by the footer. */
export interface AgentSession {
	readonly state: FooterSessionState;
	readonly sessionManager: FooterSessionManager;
	readonly modelRegistry: FooterModelRegistry;
	getContextUsage(): FooterContextUsage | undefined;
}

/** Local equivalent of pi's core/experimental.ts. */
function areExperimentalFeaturesEnabled(): boolean {
	return process.env.PI_EXPERIMENTAL === "1";
}

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for compact footer display.
 */
function formatTokens(count: number): string {
	const clamped = Math.max(0, count);
	if (clamped >= 1_000_000) return formatCompactUnit(clamped / 1_000_000, "M");
	if (clamped >= 1000) return formatCompactUnit(clamped / 1000, "K");
	return String(Math.round(clamped));
}

function formatCompactUnit(value: number, unit: string): string {
	const rounded = Math.round(value * 10) / 10;
	return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}${unit}`;
}

function contextMode(preferences: StatusLinePreferences): "off" | "tokens" | "tokens-percent" | "percent" {
	if (preferences.statusContextMode === "off" || preferences.statusShowContext === false) return "off";
	if (preferences.statusContextMode === "percent") return "percent";
	if (preferences.statusContextMode === "tokens-percent" || preferences.statusShowContextPercent === true) return "tokens-percent";
	return "tokens";
}

function showStatusPart(preferences: StatusLinePreferences, key: keyof StatusLinePreferences): boolean {
	if (key === "statusShowContextPercent") return preferences[key] === true;
	return preferences[key] !== false;
}

export function formatContextDisplay(
	preferences: StatusLinePreferences,
	tokens: number | null,
	contextWindow: number,
	percent: string,
): string | undefined {
	const mode = contextMode(preferences);
	if (mode === "off") return undefined;
	const tokenDisplay = tokens === null ? "?" : formatTokens(tokens);
	const windowDisplay = contextWindow > 0 ? formatTokens(contextWindow) : "?";
	if (mode === "percent") return percent === "?" ? "?%" : `${percent}%`;
	const base = `${tokenDisplay}/${windowDisplay}`;
	if (mode === "tokens-percent" && percent !== "?") return `${base} (${percent}%)`;
	return base;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function formatConfiguredWindow(tokens: number): string {
	return formatTokens(tokens);
}

function formatCostUsd(value: number): string {
	if (value <= 0) return "$0.0000";
	if (value < 0.0001) return "<$0.0001";
	if (value < 1) return `$${value.toFixed(4)}`;
	if (value < 100) return `$${value.toFixed(2)}`;
	return `$${Math.round(value).toLocaleString()}`;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private statusLine: StatusLinePreferences;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider, statusLine: StatusLinePreferences = {}) {
		this.session = session;
		this.footerData = footerData;
		this.statusLine = statusLine;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	setStatusLinePreferences(statusLine: StatusLinePreferences): void {
		this.statusLine = statusLine;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	render(width: number): string[] {
		const state = this.session.state;

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;
		let latestCacheHitRate: number | undefined;

		for (const entry of this.session.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				totalInput += entry.message.usage.input;
				totalOutput += entry.message.usage.output;
				totalCacheRead += entry.message.usage.cacheRead;
				totalCacheWrite += entry.message.usage.cacheWrite;
				totalCost += entry.message.usage.cost.total;

				const latestPromptTokens =
					entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
				latestCacheHitRate =
					latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;
			}
		}

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
		const contextTokens = contextUsage?.tokens ?? null;

		const pwdParts: string[] = [];
		if (showStatusPart(this.statusLine, "statusShowAppName")) {
			pwdParts.push("Furnace");
		}
		if (showStatusPart(this.statusLine, "statusShowCwd")) {
			let cwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
			const branch = this.footerData.getGitBranch();
			if (branch) {
				cwd = `${cwd} (${branch})`;
			}
			pwdParts.push(cwd);
		}
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName && showStatusPart(this.statusLine, "statusShowTitle")) {
			pwdParts.push(sessionName);
		}
		if (state.forkParentTitle && showStatusPart(this.statusLine, "statusShowForkParent")) {
			pwdParts.push(`fork of: ${state.forkParentTitle}`);
		}
		const pwd = pwdParts.join(" • ");

		// Build stats line
		const statsParts = [];
		if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
		if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
		if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
		if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
		if ((totalCacheRead > 0 || totalCacheWrite > 0) && latestCacheHitRate !== undefined) {
			statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
		}

		// Show cost with "(sub)" indicator if using OAuth subscription
		const usingSubscription = state.model ? this.session.modelRegistry.isUsingOAuth(state.model) : false;
		if (showStatusPart(this.statusLine, "statusShowCost")) {
			const costStr = `${formatCostUsd(totalCost)}${usingSubscription ? " (sub)" : ""}`;
			statsParts.push(costStr);
		}

		const contextDisplay = formatContextDisplay(this.statusLine, contextTokens, contextWindow, contextPercent);
		if (contextDisplay) {
			let contextDisplayStr: string;
			if (contextPercentValue > 90) {
				contextDisplayStr = theme.fg("error", contextDisplay);
			} else if (contextPercentValue > 70) {
				contextDisplayStr = theme.fg("warning", contextDisplay);
			} else {
				contextDisplayStr = contextDisplay;
			}
			statsParts.push(contextDisplayStr);
		}
		if (areExperimentalFeaturesEnabled()) {
			statsParts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
		}
		if (showStatusPart(this.statusLine, "statusShowMode")) {
			statsParts.push(`mode: ${state.mode || "agent"}`);
		}
		if (showStatusPart(this.statusLine, "statusShowWindow") && state.configuredContextWindow) {
			statsParts.push(`window: ${formatConfiguredWindow(state.configuredContextWindow)}`);
		}
		if (showStatusPart(this.statusLine, "statusShowReasoning")) {
			const reasoning = !state.thinkingLevel || state.thinkingLevel === "off" ? "none" : state.thinkingLevel;
			statsParts.push(`reasoning: ${reasoning}`);
		}
		if (showStatusPart(this.statusLine, "statusShowFast") && state.fast) {
			statsParts.push("fast");
		}
		if (showStatusPart(this.statusLine, "statusShowTheme") && state.themeName) {
			statsParts.push(`theme: ${state.themeName}`);
		}

		let statsLeft = statsParts.join(" ");

		// Add model name on the right side
		const modelName = state.model?.name || state.model?.id || "no-model";

		let statsLeftWidth = visibleWidth(statsLeft);

		// If statsLeft is too wide, truncate it
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		// Calculate available space for padding (minimum 2 spaces between stats and model)
		const minPadding = 2;

		let rightSideWithoutProvider = showStatusPart(this.statusLine, "statusShowModel") ? modelName : "";

		// Prepend the provider in parentheses if there are multiple providers and there's enough room
		let rightSide = rightSideWithoutProvider;
		if (rightSide && this.footerData.getAvailableProviderCount() > 1 && state.model) {
			rightSide = `(${state.model!.provider}) ${rightSideWithoutProvider}`;
			if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
				// Too wide, fall back
				rightSide = rightSideWithoutProvider;
			}
		}

		const rightSideWidth = visibleWidth(rightSide);
		const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

		let statsLine: string;
		if (!rightSide) {
			statsLine = statsLeft;
		} else if (totalNeeded <= width) {
			// Both fit - add padding to right-align model
			const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
			statsLine = statsLeft + padding + rightSide;
		} else {
			// Need to truncate right side
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 0) {
				const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
				const truncatedRightWidth = visibleWidth(truncatedRight);
				const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
				statsLine = statsLeft + padding + truncatedRight;
			} else {
				// Not enough space for right side at all
				statsLine = statsLeft;
			}
		}

		// Apply dim to each part separately. statsLeft may contain color codes (for context %)
		// that end with a reset, which would clear an outer dim wrapper. So we dim the parts
		// before and after the colored section independently.
		const dimStatsLeft = theme.fg("dim", statsLeft);
		const remainder = statsLine.slice(statsLeft.length); // padding + rightSide
		const dimRemainder = theme.fg("dim", remainder);

		const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
		const lines = [pwdLine, dimStatsLeft + dimRemainder];

		// Add extension statuses on a single line, sorted by key alphabetically
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.filter(([key]) => key !== "mode" || showStatusPart(this.statusLine, "statusShowMode"))
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}
}
