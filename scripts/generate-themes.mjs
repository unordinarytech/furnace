#!/usr/bin/env node
// AUTO-GENERATED theme converter — reads iTerm2-Color-Schemes YAML and emits Furnace Theme objects.
// Usage: node scripts/generate-themes.mjs [path-to-iTerm2-Color-Schemes-repo]

import { readdir, readFile, writeFile } from "node:fs/promises"
import { join, basename, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const currentDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(currentDir, "..")
const defaultSource = join(repoRoot, "..", "iTerm2-Color-Schemes", "yaml")
const sourceDir = process.argv[2] || defaultSource
const outputPath = join(repoRoot, "src", "ui", "terminal-themes", "generated.ts")

// ─── ANSI color indices ───
// Standard terminal 16-color palette mapping:
// 01=black  02=red    03=green  04=yellow  05=blue   06=magenta 07=cyan   08=white(bright-black)
// 09=bright-black  10=bright-red 11=bright-green 12=bright-yellow 13=bright-blue 14=bright-magenta 15=bright-cyan 16=bright-white

// ─── Existing hand-crafted theme names to avoid colliding with ───
const existingNames = new Set([
  "flexoki", "default", "dracula", "catppuccin", "tokyo-night", "nord", "rosepine", "gruvbox",
])

// ─── Simple YAML parser for the iTerm2-Color-Schemes format ───
// Handles: key: "value"  |  key: value  |  key: "value" # comment  |  key: value # comment
function parseYaml(text) {
  const result = {}
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("---")) continue
    const colonIdx = trimmed.indexOf(":")
    if (colonIdx < 0) continue
    const key = trimmed.slice(0, colonIdx).trim()
    let rest = trimmed.slice(colonIdx + 1).trim()

    // Check if value is quoted
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const quoteChar = rest[0]
      const closingIdx = rest.indexOf(quoteChar, 1)
      if (closingIdx > 0) {
        rest = rest.slice(1, closingIdx)
      } else {
        // Unclosed quote — take everything
        rest = rest.slice(1)
      }
    } else {
      // Unquoted: strip inline comments (# ...)
      const hashIdx = rest.indexOf("#")
      if (hashIdx >= 0) rest = rest.slice(0, hashIdx).trim()
    }

    result[key] = rest
  }
  return result
}

// ─── Color utilities ───
function hexToRgb(hex) {
  const h = hex.replace("#", "")
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  }
}

function rgbToHex(r, g, b) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)))
  return "#" + [r, g, b].map((v) => clamp(v).toString(16).padStart(2, "0")).join("")
}

function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex)
  const linearize = (c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b)
}

function contrastRatio(hex1, hex2) {
  const l1 = relativeLuminance(hex1)
  const l2 = relativeLuminance(hex2)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

function darken(hex, amount) {
  const { r, g, b } = hexToRgb(hex)
  return rgbToHex(r * (1 - amount), g * (1 - amount), b * (1 - amount))
}

function dim(hex, amount) {
  const { r, g, b } = hexToRgb(hex)
  return rgbToHex(r * (1 - amount), g * (1 - amount), b * (1 - amount))
}

// Pick readable foreground color for a given background color
function foregroundFor(bgHex, themeBg, themeFg) {
  return relativeLuminance(bgHex) > 0.4 ? themeBg : themeFg
}

// ─── Convert a parsed YAML theme to a Furnace Theme object ───
function convertTheme(yaml, fileName) {
  const bg = yaml.background || "#000000"
  const fg = yaml.foreground || "#ffffff"
  const selection = yaml.selection || bg
  const selectionText = yaml.selection_text || fg

  // ANSI colors — iTerm2-Color-Schemes uses 1-indexed slots
  // color_01..color_08 = standard 8 (black, red, green, yellow, blue, magenta, cyan, white)
  // color_09..color_16 = bright variants of the above
  const c01 = yaml.color_01 || "#000000" // black
  const c02 = yaml.color_02 || "#ff0000" // red
  const c03 = yaml.color_03 || "#00ff00" // green
  const c04 = yaml.color_04 || "#ffff00" // yellow
  const c05 = yaml.color_05 || "#0000ff" // blue
  const c06 = yaml.color_06 || "#ff00ff" // magenta
  const c07 = yaml.color_07 || "#00ffff" // cyan
  // c08 = white (typically a light grey) — NOT the dim grey
  // bright-black = dark grey; validate it's readable against bg (>= 2:1), else derive one
  const rawC09 = yaml.color_09
  const c09 = (() => {
    if (rawC09 && contrastRatio(rawC09, bg) >= 2.0) return rawC09
    // Fallback: blend fg toward bg at 60% — gives a mid-tone muted colour
    const bgRgb = hexToRgb(bg)
    const fgRgb = hexToRgb(fg)
    return rgbToHex(
      bgRgb.r + (fgRgb.r - bgRgb.r) * 0.4,
      bgRgb.g + (fgRgb.g - bgRgb.g) * 0.4,
      bgRgb.b + (fgRgb.b - bgRgb.b) * 0.4,
    )
  })()
  const c10 = yaml.color_10 || c02 // bright red
  const c11 = yaml.color_11 || c03 // bright green
  const c13 = yaml.color_13 || c05 // bright blue
  const c14 = yaml.color_14 || c06 // bright magenta
  const c15 = yaml.color_15 || c07 // bright cyan
  const c16 = yaml.color_16 || fg  // bright white

  // Semantic mapping
  const error = c02
  const success = c03
  const warning = c04
  const info = c05
  const accent = c14 // bright magenta — commonly accent
  const secondary = c15 // bright cyan — commonly secondary
  // muted surface: use palette's black if it's darker than bg, else darken bg slightly
  const bgLum = relativeLuminance(bg)
  const c01Lum = relativeLuminance(c01)
  const muted = c01Lum < bgLum ? c01 : darken(bg, 0.1)
  const mutedFg = c09 // bright-black = dark grey, the proper muted text slot
  const border = c09
  const primary = c13 // bright blue
  const focusRing = c13
  const borderColor = c09
  const focusColor = c13

  return {
    name: slugify(yaml.name || basename(fileName, ".yml")),
    colors: {
      background: bg,
      foreground: fg,
      muted,
      mutedForeground: mutedFg,
      border,
      primary,
      primaryForeground: foregroundFor(primary, bg, fg),
      secondary,
      secondaryForeground: foregroundFor(secondary, bg, fg),
      accent,
      accentForeground: foregroundFor(accent, bg, fg),
      success,
      successForeground: foregroundFor(success, bg, fg),
      warning,
      warningForeground: foregroundFor(warning, bg, fg),
      error,
      errorForeground: foregroundFor(error, bg, fg),
      info,
      infoForeground: foregroundFor(info, bg, fg),
      selection,
      selectionForeground: selectionText,
      focusRing,
    },
    spacing: { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 6: 6, 8: 8 },
    typography: { base: "", bold: true, lg: "bold", sm: "dim", xl: "bold" },
    border: { color: borderColor, focusColor: focusColor, style: "round" },
  }
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
}

function titleCase(slug) {
  return slug
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

// ─── Dedup by visual appearance (bg + fg + primary dominate TUI look) ───
function colorHash(theme) {
  const c = theme.colors
  return [c.background, c.foreground, c.primary, c.accent].join("|")
}

// ─── Main ───
async function main() {
  const files = await readdir(sourceDir)
  const ymlFiles = files.filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))

  console.log(`Found ${ymlFiles.length} YAML theme files`)

  const themes = []
  const seenSlugs = new Set(existingNames)
  const seenHashes = new Set()
  let skippedLight = 0
  let skippedLowContrast = 0
  let skippedDupe = 0
  let skippedCollision = 0

  for (const file of ymlFiles.sort()) {
    const filePath = join(sourceDir, file)
    const text = await readFile(filePath, "utf8")
    const yaml = parseYaml(text)

    // Filter: skip light themes — detect by background luminance (> 0.35 = light bg)
    if (yaml.background) {
      if (relativeLuminance(yaml.background) > 0.35) {
        skippedLight++
        continue
      }
    } else if (yaml.variant && yaml.variant.toLowerCase() === "light") {
      skippedLight++
      continue
    }

    // Filter: skip low contrast (fg/bg ratio < 3:1)
    if (yaml.background && yaml.foreground) {
      const ratio = contrastRatio(yaml.background, yaml.foreground)
      if (ratio < 3.0) {
        skippedLowContrast++
        continue
      }
    }

    const theme = convertTheme(yaml, file)

    // Filter: skip name collision with existing hand-crafted themes
    if (existingNames.has(theme.name)) {
      skippedCollision++
      continue
    }

    // Filter: skip duplicate slug
    if (seenSlugs.has(theme.name)) {
      skippedDupe++
      continue
    }

    // Filter: skip near-duplicate color schemes
    const hash = colorHash(theme)
    if (seenHashes.has(hash)) {
      skippedDupe++
      continue
    }

    seenSlugs.add(theme.name)
    seenHashes.add(hash)
    themes.push(theme)
  }

  console.log(`Converted: ${themes.length} themes`)
  console.log(`Skipped: ${skippedLight} light, ${skippedLowContrast} low-contrast, ${skippedDupe} duplicates, ${skippedCollision} name collisions`)

  // Sort alphabetically by name
  themes.sort((a, b) => a.name.localeCompare(b.name))

  // Generate TypeScript file
  const lines = [
    "// AUTO-GENERATED by scripts/generate-themes.mjs — do not edit manually.",
    "// Source: https://github.com/mbadolato/iTerm2-Color-Schemes",
    "// Converted from iTerm2 YAML color schemes to Furnace Theme objects.",
    "",
    'import type { Theme } from "../components/theme-provider.js"',
    "",
    "export const generatedThemes: Theme[] = [",
  ]

  for (const t of themes) {
    lines.push(`  ${JSON.stringify(t)},`)
  }

  lines.push("]")
  lines.push("")

  // Also generate ThemeChoice metadata
  const choiceLines = [
    "",
    "export type GeneratedThemeChoice = {",
    "  description: string",
    "  displayLabel: string",
    "  name: string",
    "}",
    "",
    "export const generatedThemeChoices: GeneratedThemeChoice[] = [",
  ]

  for (const t of themes) {
    choiceLines.push(`  { name: ${JSON.stringify(t.name)}, displayLabel: ${JSON.stringify(titleCase(t.name))}, description: "Converted from iTerm2-Color-Schemes" },`)
  }

  choiceLines.push("]")
  choiceLines.push("")

  const output = lines.join("\n") + choiceLines.join("\n")
  await writeFile(outputPath, output, "utf8")
  console.log(`Written: ${outputPath} (${themes.length} themes)`)
}

main().catch((err) => {
  console.error("Error:", err)
  process.exit(1)
})
