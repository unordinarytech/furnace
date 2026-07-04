import * as React from "react"

import { flexokiTheme } from "../terminal-themes/flexoki.js"

export type BorderStyle = "single" | "double" | "round" | "bold" | "singleDouble" | "doubleSingle" | "classic"

export type ColorTokens = {
  primary: string
  primaryForeground: string
  secondary: string
  secondaryForeground: string
  accent: string
  accentForeground: string
  success: string
  successForeground: string
  warning: string
  warningForeground: string
  error: string
  errorForeground: string
  info: string
  infoForeground: string
  background: string
  foreground: string
  muted: string
  mutedForeground: string
  border: string
  focusRing: string
  selection: string
  selectionForeground: string
}

export type SpacingTokens = {
  0: number
  1: number
  2: number
  3: number
  4: number
  6: number
  8: number
}

export type TypographyTokens = {
  bold: boolean
  sm: string
  base: string
  lg: string
  xl: string
}

export type BorderTokens = {
  style: BorderStyle
  color: string
  focusColor: string
}

export type Theme = {
  name: string
  colors: ColorTokens
  spacing: SpacingTokens
  typography: TypographyTokens
  border: BorderTokens
}

export type ThemeProviderProps = {
  children: React.ReactNode
  noUnicode?: boolean
  reducedMotion?: boolean
  theme?: Theme
}

type MotionContextValue = {
  reduced: boolean
}

type UnicodeContextValue = {
  unicode: boolean
}

type ThemeContextValue = {
  setTheme: (theme: Theme) => void
  theme: Theme
}

const getEnv = (name: string): string | undefined => (typeof process !== "undefined" && process.env ? process.env[name] : undefined)

export function isReducedMotion(): boolean {
  return getEnv("FURNACE_REDUCED_MOTION") === "1" || getEnv("NO_MOTION") === "1" || getEnv("CI") === "true" || getEnv("TERM") === "dumb"
}

function detectUnicodeSupport(): boolean {
  if (getEnv("NO_UNICODE") === "1" || getEnv("NO_UNICODE") === "true") return false
  if (getEnv("WT_SESSION") || getEnv("WSL_DISTRO_NAME")) return true
  if (process.platform === "darwin" || process.platform === "linux") return true
  return true
}

const MotionContext = React.createContext<MotionContextValue>({ reduced: isReducedMotion() })
const UnicodeContext = React.createContext<UnicodeContextValue>({ unicode: detectUnicodeSupport() })
const ThemeContext = React.createContext<ThemeContextValue>({
  setTheme: () => {},
  theme: flexokiTheme,
})

export function ThemeProvider({ children, noUnicode, reducedMotion, theme = flexokiTheme }: ThemeProviderProps): React.ReactNode {
  const motionValue = React.useMemo(() => ({ reduced: reducedMotion ?? isReducedMotion() }), [reducedMotion])
  const unicodeValue = React.useMemo(() => ({ unicode: noUnicode === undefined ? detectUnicodeSupport() : !noUnicode }), [noUnicode])
  const themeValue = React.useMemo(() => ({ setTheme: () => {}, theme }), [theme])

  return (
    <MotionContext.Provider value={motionValue}>
      <UnicodeContext.Provider value={unicodeValue}>
        <ThemeContext.Provider value={themeValue}>{children}</ThemeContext.Provider>
      </UnicodeContext.Provider>
    </MotionContext.Provider>
  )
}

export const useMotion = (): MotionContextValue => React.useContext(MotionContext)
export const useUnicode = (): boolean => React.useContext(UnicodeContext).unicode
export const useTheme = (): Theme => React.useContext(ThemeContext).theme
export const useThemeUpdater = (): ((theme: Theme) => void) => React.useContext(ThemeContext).setTheme

export function createTheme(overrides: Partial<Theme> & { name: string }): Theme {
  return {
    ...flexokiTheme,
    ...overrides,
    border: {
      ...flexokiTheme.border,
      ...overrides.border,
    },
    colors: {
      ...flexokiTheme.colors,
      ...overrides.colors,
    },
    spacing: {
      ...flexokiTheme.spacing,
      ...overrides.spacing,
    },
    typography: {
      ...flexokiTheme.typography,
      ...overrides.typography,
    },
  }
}
