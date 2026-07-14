import type { Theme } from "../themes/types.js"

const spacing = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 6: 6, 8: 8 }
const typography = { base: "", bold: true, lg: "bold", sm: "dim", xl: "bold" } as const

/**
 * Space — deep cosmos palette
 *
 * Background: void black (#0a0e17)
 * Primary:    nebula blue (#4d9fff)
 * Accent:     stellar purple (#a78bfa)
 * Secondary:  aurora cyan (#22d3ee)
 * Success:    pulsar green (#34d399)
 * Warning:    solar amber (#f59e0b)
 * Error:      red dwarf (#f87171)
 * Info:       comet teal (#5eead4)
 * Muted:      deep space (#111827)
 * Foreground: starlight (#e2e8f0)
 */
export const spaceTheme: Theme = {
  name: "space",
  border: { color: "#1e3a5f", focusColor: "#4d9fff", style: "round" },
  colors: {
    background: "#0a0e17",
    foreground: "#e2e8f0",
    muted: "#111827",
    mutedForeground: "#4b5563",
    border: "#1e3a5f",
    focusRing: "#4d9fff",

    primary: "#4d9fff",
    primaryForeground: "#0a0e17",
    secondary: "#1e293b",
    secondaryForeground: "#e2e8f0",
    accent: "#a78bfa",
    accentForeground: "#0a0e17",

    success: "#34d399",
    successForeground: "#0a0e17",
    warning: "#f59e0b",
    warningForeground: "#0a0e17",
    error: "#f87171",
    errorForeground: "#0a0e17",
    info: "#5eead4",
    infoForeground: "#0a0e17",

    selection: "#1e3a5f",
    selectionForeground: "#e2e8f0",

    // Pi-style message backgrounds
    userMessageBg: "#111827",
    userMessageText: "#e2e8f0",
    toolPendingBg: "#0f1929",
    toolSuccessBg: "#0c1f18",
    toolErrorBg: "#1f0c0c",
    toolTitle: "#e2e8f0",
    toolOutput: "#4b5563",
  },
  spacing,
  typography,
}
