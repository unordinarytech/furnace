/**
 * Pi's interactive-mode theme engine, ported from pi
 * (https://github.com/earendil-works/pi). MIT License,
 * Copyright (c) 2025 Mario Zechner.
 *
 * Furnace adaptation: themes are built from furnace's terminal theme
 * palettes (src/ui/themes) instead of pi's JSON theme files, so
 * the rendering pipeline is identical to pi while the colors stay
 * furnace's own.
 */
import {
	type EditorTheme,
	getCapabilities,
	type MarkdownTheme,
	type SelectListTheme,
	type SettingsListTheme,
} from "@earendil-works/pi-tui"
import chalk from "chalk"
import { themeChoices, resolveTheme } from "../themes/index.js"
import type { Theme as FurnaceTheme } from "../themes/types.js"
import { highlight, supportsLanguage } from "./syntax-highlight.js"

// ============================================================================
// Types
// ============================================================================

type ColorValue = string | number

export type ThemeColor =
	| "accent"
	| "border"
	| "borderAccent"
	| "borderMuted"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text"
	| "thinkingText"
	| "userMessageText"
	| "customMessageText"
	| "customMessageLabel"
	| "toolTitle"
	| "toolOutput"
	| "mdHeading"
	| "mdLink"
	| "mdLinkUrl"
	| "mdCode"
	| "mdCodeBlock"
	| "mdCodeBlockBorder"
	| "mdQuote"
	| "mdQuoteBorder"
	| "mdHr"
	| "mdListBullet"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "toolDiffContext"
	| "syntaxComment"
	| "syntaxKeyword"
	| "syntaxFunction"
	| "syntaxVariable"
	| "syntaxString"
	| "syntaxNumber"
	| "syntaxType"
	| "syntaxOperator"
	| "syntaxPunctuation"
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "bashMode"

export type ThemeBg =
	| "selectedBg"
	| "userMessageBg"
	| "customMessageBg"
	| "toolPendingBg"
	| "toolSuccessBg"
	| "toolErrorBg"

type ColorMode = "truecolor" | "256color"

// ============================================================================
// Color Utilities (verbatim from pi)
// ============================================================================

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	let cleaned = hex.replace("#", "")
	// Furnace palettes may use #rgb shorthand or #rrggbbaa with alpha; pi's
	// engine works on rgb, so expand shorthand and drop the alpha channel.
	if (cleaned.length === 3) {
		cleaned = cleaned.split("").map((ch) => ch + ch).join("")
	}
	if (cleaned.length === 8) {
		cleaned = cleaned.slice(0, 6)
	}
	if (cleaned.length !== 6) {
		throw new Error(`Invalid hex color: ${hex}`)
	}
	const r = parseInt(cleaned.substring(0, 2), 16)
	const g = parseInt(cleaned.substring(2, 4), 16)
	const b = parseInt(cleaned.substring(4, 6), 16)
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
		throw new Error(`Invalid hex color: ${hex}`)
	}
	return { r, g, b }
}

const CUBE_VALUES = [0, 95, 135, 175, 215, 255]
const GRAY_VALUES = Array.from({ length: 24 }, (_, i) => 8 + i * 10)

function findClosestCubeIndex(value: number): number {
	let minDist = Infinity
	let minIdx = 0
	for (let i = 0; i < CUBE_VALUES.length; i++) {
		const dist = Math.abs(value - CUBE_VALUES[i]!)
		if (dist < minDist) {
			minDist = dist
			minIdx = i
		}
	}
	return minIdx
}

function findClosestGrayIndex(gray: number): number {
	let minDist = Infinity
	let minIdx = 0
	for (let i = 0; i < GRAY_VALUES.length; i++) {
		const dist = Math.abs(gray - GRAY_VALUES[i]!)
		if (dist < minDist) {
			minDist = dist
			minIdx = i
		}
	}
	return minIdx
}

function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
	const dr = r1 - r2
	const dg = g1 - g2
	const db = b1 - b2
	return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114
}

function rgbTo256(r: number, g: number, b: number): number {
	const rIdx = findClosestCubeIndex(r)
	const gIdx = findClosestCubeIndex(g)
	const bIdx = findClosestCubeIndex(b)
	const cubeR = CUBE_VALUES[rIdx]!
	const cubeG = CUBE_VALUES[gIdx]!
	const cubeB = CUBE_VALUES[bIdx]!
	const cubeIndex = 16 + 36 * rIdx + 6 * gIdx + bIdx
	const cubeDist = colorDistance(r, g, b, cubeR, cubeG, cubeB)

	const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
	const grayIdx = findClosestGrayIndex(gray)
	const grayValue = GRAY_VALUES[grayIdx]!
	const grayIndex = 232 + grayIdx
	const grayDist = colorDistance(r, g, b, grayValue, grayValue, grayValue)

	const maxC = Math.max(r, g, b)
	const minC = Math.min(r, g, b)
	const spread = maxC - minC

	if (spread < 10 && grayDist < cubeDist) {
		return grayIndex
	}

	return cubeIndex
}

function hexTo256(hex: string): number {
	const { r, g, b } = hexToRgb(hex)
	return rgbTo256(r, g, b)
}

function fgAnsi(color: ColorValue, mode: ColorMode): string {
	if (color === "") return "\x1b[39m"
	if (typeof color === "number") return `\x1b[38;5;${color}m`
	if (color.startsWith("#")) {
		if (mode === "truecolor") {
			const { r, g, b } = hexToRgb(color)
			return `\x1b[38;2;${r};${g};${b}m`
		} else {
			const index = hexTo256(color)
			return `\x1b[38;5;${index}m`
		}
	}
	throw new Error(`Invalid color value: ${color}`)
}

function bgAnsi(color: ColorValue, mode: ColorMode): string {
	if (color === "") return "\x1b[49m"
	if (typeof color === "number") return `\x1b[48;5;${color}m`
	if (color.startsWith("#")) {
		if (mode === "truecolor") {
			const { r, g, b } = hexToRgb(color)
			return `\x1b[48;2;${r};${g};${b}m`
		} else {
			const index = hexTo256(color)
			return `\x1b[48;5;${index}m`
		}
	}
	throw new Error(`Invalid color value: ${color}`)
}

// ============================================================================
// Theme Class (verbatim from pi)
// ============================================================================

export class Theme {
	readonly name?: string
	private fgColors: Map<ThemeColor, string>
	private bgColors: Map<ThemeBg, string>
	private mode: ColorMode

	constructor(
		fgColors: Record<ThemeColor, ColorValue>,
		bgColors: Record<ThemeBg, ColorValue>,
		mode: ColorMode,
		options: { name?: string } = {},
	) {
		this.name = options.name
		this.mode = mode
		this.fgColors = new Map()
		for (const [key, value] of Object.entries(fgColors) as [ThemeColor, ColorValue][]) {
			this.fgColors.set(key, fgAnsi(value, mode))
		}
		this.bgColors = new Map()
		for (const [key, value] of Object.entries(bgColors) as [ThemeBg, ColorValue][]) {
			this.bgColors.set(key, bgAnsi(value, mode))
		}
	}

	fg(color: ThemeColor, text: string): string {
		const ansi = this.fgColors.get(color)
		if (!ansi) throw new Error(`Unknown theme color: ${color}`)
		return `${ansi}${text}\x1b[39m` // Reset only foreground color
	}

	bg(color: ThemeBg, text: string): string {
		const ansi = this.bgColors.get(color)
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`)
		return `${ansi}${text}\x1b[49m` // Reset only background color
	}

	bold(text: string): string {
		return chalk.bold(text)
	}

	italic(text: string): string {
		return chalk.italic(text)
	}

	underline(text: string): string {
		return chalk.underline(text)
	}

	inverse(text: string): string {
		return chalk.inverse(text)
	}

	strikethrough(text: string): string {
		return chalk.strikethrough(text)
	}

	getFgAnsi(color: ThemeColor): string {
		const ansi = this.fgColors.get(color)
		if (!ansi) throw new Error(`Unknown theme color: ${color}`)
		return ansi
	}

	getBgAnsi(color: ThemeBg): string {
		const ansi = this.bgColors.get(color)
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`)
		return ansi
	}

	getColorMode(): ColorMode {
		return this.mode
	}

	getThinkingBorderColor(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): (str: string) => string {
		switch (level) {
			case "off":
				return (str: string) => this.fg("thinkingOff", str)
			case "minimal":
				return (str: string) => this.fg("thinkingMinimal", str)
			case "low":
				return (str: string) => this.fg("thinkingLow", str)
			case "medium":
				return (str: string) => this.fg("thinkingMedium", str)
			case "high":
				return (str: string) => this.fg("thinkingHigh", str)
			case "xhigh":
				return (str: string) => this.fg("thinkingXhigh", str)
			default:
				return (str: string) => this.fg("thinkingOff", str)
		}
	}

	getBashModeBorderColor(): (str: string) => string {
		return (str: string) => this.fg("bashMode", str)
	}
}

// ============================================================================
// Furnace palette → pi semantic slots
// ============================================================================

/** Pi's exact dark-theme values for slots furnace palettes don't define. */
const PI_DARK_SYNTAX = {
	syntaxComment: "#6A9955",
	syntaxKeyword: "#569CD6",
	syntaxFunction: "#DCDCAA",
	syntaxVariable: "#9CDCFE",
	syntaxString: "#CE9178",
	syntaxNumber: "#B5CEA8",
	syntaxType: "#4EC9B0",
	syntaxOperator: "#D4D4D4",
	syntaxPunctuation: "#D4D4D4",
} as const

function furnaceThemeToPiTheme(furnace: FurnaceTheme, mode?: ColorMode): Theme {
	const c = furnace.colors
	const colorMode = mode ?? (getCapabilities().trueColor ? "truecolor" : "256color")
	const isPiDark = furnace.name === "pi-dark"

	const fgColors: Record<ThemeColor, ColorValue> = {
		accent: c.accent,
		border: c.border,
		borderAccent: c.focusRing,
		borderMuted: isPiDark ? "#505050" : c.muted,
		success: c.success,
		error: c.error,
		warning: c.warning,
		muted: c.mutedForeground,
		dim: isPiDark ? "#666666" : c.mutedForeground,
		text: c.foreground,
		thinkingText: c.mutedForeground,
		userMessageText: c.userMessageText ?? c.foreground,
		customMessageText: c.foreground,
		customMessageLabel: isPiDark ? "#9575cd" : c.primary,
		toolTitle: c.toolTitle ?? c.foreground,
		toolOutput: c.toolOutput ?? c.mutedForeground,
		mdHeading: isPiDark ? "#f0c674" : c.primary,
		mdLink: isPiDark ? "#81a2be" : c.info,
		mdLinkUrl: isPiDark ? "#666666" : c.mutedForeground,
		mdCode: c.accent,
		mdCodeBlock: isPiDark ? c.success : c.secondary,
		mdCodeBlockBorder: c.mutedForeground,
		mdQuote: c.mutedForeground,
		mdQuoteBorder: c.mutedForeground,
		mdHr: c.mutedForeground,
		mdListBullet: c.accent,
		toolDiffAdded: c.success,
		toolDiffRemoved: c.error,
		toolDiffContext: c.mutedForeground,
		...(isPiDark
			? PI_DARK_SYNTAX
			: {
					syntaxComment: c.mutedForeground,
					syntaxKeyword: c.primary,
					syntaxFunction: c.warning,
					syntaxVariable: c.info,
					syntaxString: c.success,
					syntaxNumber: c.secondary,
					syntaxType: c.accent,
					syntaxOperator: c.foreground,
					syntaxPunctuation: c.foreground,
				}),
		thinkingOff: isPiDark ? "#505050" : c.muted,
		thinkingMinimal: isPiDark ? "#6e6e6e" : c.mutedForeground,
		thinkingLow: isPiDark ? "#5f87af" : c.info,
		thinkingMedium: isPiDark ? "#81a2be" : c.primary,
		thinkingHigh: isPiDark ? "#b294bb" : c.accent,
		thinkingXhigh: isPiDark ? "#d183e8" : c.focusRing,
		bashMode: c.success,
	}

	const bgColors: Record<ThemeBg, ColorValue> = {
		selectedBg: c.selection,
		userMessageBg: c.userMessageBg ?? c.muted,
		customMessageBg: isPiDark ? "#2d2838" : c.muted,
		toolPendingBg: c.toolPendingBg ?? c.muted,
		toolSuccessBg: c.toolSuccessBg ?? c.muted,
		toolErrorBg: c.toolErrorBg ?? c.muted,
	}

	return new Theme(fgColors, bgColors, colorMode, { name: furnace.name })
}

// ============================================================================
// Global Theme Instance (pi pattern: shared proxy + change callback)
// ============================================================================

const THEME_KEY = Symbol.for("cook-furnace:pi-theme")

export const theme: Theme = new Proxy({} as Theme, {
	get(_target, prop) {
		const t = (globalThis as Record<symbol, Theme>)[THEME_KEY]
		if (!t) throw new Error("Theme not initialized. Call initTheme() first.")
		return (t as unknown as Record<string | symbol, unknown>)[prop]
	},
})

function setGlobalTheme(t: Theme): void {
	;(globalThis as Record<symbol, Theme>)[THEME_KEY] = t
}

let currentThemeName: string | undefined
let onThemeChangeCallback: (() => void) | undefined

export function getAvailableThemes(): string[] {
	return themeChoices.map((choice) => choice.name)
}

export function getThemeByName(name: string): Theme | undefined {
	const choice = themeChoices.find((c) => c.name === name)
	if (!choice) return undefined
	return furnaceThemeToPiTheme(choice.theme)
}

export function getCurrentThemeName(): string | undefined {
	return currentThemeName
}

export function initTheme(themeName?: string): void {
	const choice = resolveTheme(themeName)
	currentThemeName = choice.name
	setGlobalTheme(furnaceThemeToPiTheme(choice.theme))
}

export function setTheme(name: string): { success: boolean; error?: string } {
	const loaded = getThemeByName(name)
	if (!loaded) {
		return { success: false, error: `Theme not found: ${name}` }
	}
	currentThemeName = name
	setGlobalTheme(loaded)
	if (onThemeChangeCallback) {
		onThemeChangeCallback()
	}
	return { success: true }
}

export function onThemeChange(callback: () => void): void {
	onThemeChangeCallback = callback
}

// ============================================================================
// TUI Helpers (verbatim from pi)
// ============================================================================

type CliHighlightTheme = Record<string, (s: string) => string>

let cachedHighlightThemeFor: Theme | undefined
let cachedCliHighlightTheme: CliHighlightTheme | undefined

function buildCliHighlightTheme(t: Theme): CliHighlightTheme {
	return {
		keyword: (s: string) => t.fg("syntaxKeyword", s),
		built_in: (s: string) => t.fg("syntaxType", s),
		literal: (s: string) => t.fg("syntaxNumber", s),
		number: (s: string) => t.fg("syntaxNumber", s),
		regexp: (s: string) => t.fg("syntaxString", s),
		string: (s: string) => t.fg("syntaxString", s),
		comment: (s: string) => t.fg("syntaxComment", s),
		doctag: (s: string) => t.fg("syntaxComment", s),
		meta: (s: string) => t.fg("muted", s),
		function: (s: string) => t.fg("syntaxFunction", s),
		title: (s: string) => t.fg("syntaxFunction", s),
		class: (s: string) => t.fg("syntaxType", s),
		type: (s: string) => t.fg("syntaxType", s),
		tag: (s: string) => t.fg("syntaxPunctuation", s),
		name: (s: string) => t.fg("syntaxKeyword", s),
		attr: (s: string) => t.fg("syntaxVariable", s),
		variable: (s: string) => t.fg("syntaxVariable", s),
		params: (s: string) => t.fg("syntaxVariable", s),
		operator: (s: string) => t.fg("syntaxOperator", s),
		punctuation: (s: string) => t.fg("syntaxPunctuation", s),
		emphasis: (s: string) => t.italic(s),
		strong: (s: string) => t.bold(s),
		link: (s: string) => t.underline(s),
		addition: (s: string) => t.fg("toolDiffAdded", s),
		deletion: (s: string) => t.fg("toolDiffRemoved", s),
	}
}

function getCliHighlightTheme(t: Theme): CliHighlightTheme {
	if (cachedHighlightThemeFor !== t || !cachedCliHighlightTheme) {
		cachedHighlightThemeFor = t
		cachedCliHighlightTheme = buildCliHighlightTheme(t)
	}
	return cachedCliHighlightTheme
}

/**
 * Highlight code with syntax coloring based on file extension or language.
 * Returns array of highlighted lines.
 */
export function highlightCode(code: string, lang?: string): string[] {
	const validLang = lang && supportsLanguage(lang) ? lang : undefined
	// Skip highlighting when no valid language is specified — auto-detection
	// is unreliable and can misidentify prose as code.
	if (!validLang) {
		return code.split("\n").map((line) => theme.fg("mdCodeBlock", line))
	}
	const opts = {
		language: validLang,
		ignoreIllegals: true,
		theme: getCliHighlightTheme(theme),
	}
	try {
		return highlight(code, opts).split("\n")
	} catch {
		return code.split("\n")
	}
}

/**
 * Get language identifier from file path extension.
 */
export function getLanguageFromPath(filePath: string): string | undefined {
	const ext = filePath.split(".").pop()?.toLowerCase()
	if (!ext) return undefined

	const extToLang: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		py: "python",
		rb: "ruby",
		rs: "rust",
		go: "go",
		java: "java",
		kt: "kotlin",
		swift: "swift",
		c: "c",
		h: "c",
		cpp: "cpp",
		cc: "cpp",
		cxx: "cpp",
		hpp: "cpp",
		cs: "csharp",
		php: "php",
		sh: "bash",
		bash: "bash",
		zsh: "bash",
		fish: "fish",
		ps1: "powershell",
		sql: "sql",
		html: "html",
		htm: "html",
		css: "css",
		scss: "scss",
		sass: "sass",
		less: "less",
		json: "json",
		yaml: "yaml",
		yml: "yaml",
		toml: "toml",
		xml: "xml",
		md: "markdown",
		markdown: "markdown",
		dockerfile: "dockerfile",
		makefile: "makefile",
		cmake: "cmake",
		lua: "lua",
		perl: "perl",
		r: "r",
		scala: "scala",
		clj: "clojure",
		ex: "elixir",
		exs: "elixir",
		erl: "erlang",
		hs: "haskell",
		ml: "ocaml",
		vim: "vim",
		graphql: "graphql",
		proto: "protobuf",
		tf: "hcl",
		hcl: "hcl",
	}

	return extToLang[ext]
}

export function getMarkdownTheme(): MarkdownTheme {
	return {
		heading: (text: string) => theme.fg("mdHeading", text),
		link: (text: string) => theme.fg("mdLink", text),
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		code: (text: string) => theme.fg("mdCode", text),
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		quote: (text: string) => theme.fg("mdQuote", text),
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		hr: (text: string) => theme.fg("mdHr", text),
		listBullet: (text: string) => theme.fg("mdListBullet", text),
		bold: (text: string) => theme.bold(text),
		italic: (text: string) => theme.italic(text),
		underline: (text: string) => theme.underline(text),
		strikethrough: (text: string) => chalk.strikethrough(text),
		highlightCode: (code: string, lang?: string): string[] => {
			const validLang = lang && supportsLanguage(lang) ? lang : undefined
			if (!validLang) {
				return code.split("\n").map((line) => theme.fg("mdCodeBlock", line))
			}
			const opts = {
				language: validLang,
				ignoreIllegals: true,
				theme: getCliHighlightTheme(theme),
			}
			try {
				return highlight(code, opts).split("\n")
			} catch {
				return code.split("\n").map((line) => theme.fg("mdCodeBlock", line))
			}
		},
	}
}

export function getSelectListTheme(): SelectListTheme {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
	}
}

export function getEditorTheme(): EditorTheme {
	return {
		borderColor: (text: string) => theme.fg("border", text),
		selectList: getSelectListTheme(),
	}
}

export function getSettingsListTheme(): SettingsListTheme {
	return {
		label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
		value: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text: string) => theme.fg("dim", text),
		cursor: theme.fg("accent", "→ "),
		hint: (text: string) => theme.fg("dim", text),
	}
}
