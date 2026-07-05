import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import { PassThrough } from "node:stream"

const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h"
const MOUSE_DISABLE = "\x1b[?1000l\x1b[?1006l"

export function enableMouseTracking(): void {
  if (process.stdout.isTTY) {
    debugLog?.("enable mouse tracking")
    process.stdout.write(MOUSE_ENABLE)
  } else {
    debugLog?.("enable mouse tracking skipped: not TTY")
  }
}

export function disableMouseTracking(): void {
  if (process.stdout.isTTY) {
    debugLog?.("disable mouse tracking")
    process.stdout.write(MOUSE_DISABLE)
  }
}

export type WheelDirection = "up" | "down"

export type MouseWheelEvent = {
  direction: WheelDirection
  x: number
  y: number
}

type WheelCallback = (event: MouseWheelEvent) => void

type DataEmitter = {
  on(event: "data", listener: (data: Buffer) => void): DataEmitter
  off(event: "data", listener: (data: Buffer) => void): DataEmitter
}

export type MouseInputHandle = {
  start(): void
  stop(): void
  onWheel(callback: WheelCallback): void
}

export const debugLog = process.env.FURNACE_MOUSE_DEBUG === "1" ? (message: string) => {
  const dir = join(homedir(), ".furnace")
  try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  const path = join(dir, "mouse-debug.log")
  appendFileSync(path, `${Date.now()} ${message}\n`, "utf8")
} : undefined

export function createMouseInput(output: NodeJS.WritableStream, input: DataEmitter = process.stdin): MouseInputHandle {
  let callback: WheelCallback | undefined
  let buffer = ""
  let active = false
  let onData: ((data: Buffer) => void) | undefined

  if (debugLog) {
    const path = join(homedir(), ".furnace", "mouse-debug.log")
    try { writeFileSync(path, "") } catch { /* ignore */ }
  }

  const flush = (): void => {
    if (!buffer) return
    let forward = ""
    let i = 0
    while (i < buffer.length) {
      const escIndex = buffer.indexOf("\x1b", i)
      if (escIndex === -1) {
        forward += buffer.slice(i)
        i = buffer.length
        break
      }
      forward += buffer.slice(i, escIndex)
      i = escIndex

      const sequence = matchSgrMouseSequence(buffer, i)
      if (sequence) {
        debugLog?.(`mouse seq button=${sequence.button} x=${sequence.x} y=${sequence.y} release=${sequence.release}`)
        const event = decodeSgrMouse(sequence.button, sequence.x, sequence.y, sequence.release)
        if (event) {
          debugLog?.(`wheel ${event.direction} x=${event.x} y=${event.y}`)
          callback?.(event)
        } else {
          debugLog?.(`ignored mouse button=${sequence.button}`)
        }
        i = sequence.nextIndex
        continue
      }

      if (isSgrMousePrefix(buffer.slice(i))) {
        // Wait for more bytes; keep the prefix in the buffer.
        debugLog?.(`partial mouse prefix: ${JSON.stringify(buffer.slice(i))}`)
        break
      }

      // Not a mouse sequence; forward the ESC byte and continue scanning.
      forward += buffer[i]
      i += 1
    }

    if (forward) {
      debugLog?.(`forward ${forward.length} bytes to Ink`)
      output.write(forward)
    }
    buffer = buffer.slice(i)
  }

  onData = (data: Buffer): void => {
    debugLog?.(`stdin ${data.length} bytes: ${JSON.stringify(data.toString("utf8"))}`)
    buffer += data.toString("utf8")
    flush()
  }

  return {
    start() {
      if (active || !onData) return
      active = true
      input.on("data", onData)
    },
    stop() {
      if (!active || !onData) return
      active = false
      input.off("data", onData)
      flush()
    },
    onWheel(cb) {
      callback = cb
    },
  }
}

export function createFilteredStdin(): { stdin: NodeJS.ReadStream & NodeJS.WritableStream; mouseInput: MouseInputHandle } {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & NodeJS.WritableStream
  stdin.isTTY = true
  stdin.setRawMode = (_mode: boolean): typeof stdin => {
    // No-op: Ink will call this on the filtered stdin. The real stdin is set
    // to raw mode by createFurnaceTerminal when the app starts.
    return stdin
  }
  stdin.isRaw = true
  stdin.ref = (): typeof stdin => {
    process.stdin.ref?.()
    return stdin
  }
  stdin.unref = (): typeof stdin => {
    process.stdin.unref?.()
    return stdin
  }
  const mouseInput = createMouseInput(stdin)
  return { stdin, mouseInput }
}

function matchSgrMouseSequence(text: string, start: number): { button: number; x: number; y: number; release: boolean; nextIndex: number } | undefined {
  if (text[start] !== "\x1b") return undefined
  if (text[start + 1] !== "[") return undefined
  if (text[start + 2] !== "<") return undefined
  let index = start + 3
  let button = 0
  let sign = 1
  if (text[index] === "-") {
    sign = -1
    index += 1
  }
  let digitStart = index
  while (index < text.length && /\d/.test(text[index])) {
    button = button * 10 + (text.charCodeAt(index) - 48)
    index += 1
  }
  if (index === digitStart || text[index] !== ";") return undefined
  button *= sign
  index += 1
  let x = 0
  digitStart = index
  while (index < text.length && /\d/.test(text[index])) {
    x = x * 10 + (text.charCodeAt(index) - 48)
    index += 1
  }
  if (index === digitStart || text[index] !== ";") return undefined
  index += 1
  let y = 0
  digitStart = index
  while (index < text.length && /\d/.test(text[index])) {
    y = y * 10 + (text.charCodeAt(index) - 48)
    index += 1
  }
  if (index === digitStart) return undefined
  const char = text[index]
  if (char !== "M" && char !== "m") return undefined
  return { button, x, y, release: char === "m", nextIndex: index + 1 }
}

function isSgrMousePrefix(text: string): boolean {
  // Prefixes that could lead to a complete SGR mouse sequence. Longer prefixes
  // are checked first so an incomplete but valid-looking prefix is kept.
  if (text.startsWith("\x1b[<")) {
    const rest = text.slice(3)
    return /^\d*(;\d*){0,2};?\d*$/.test(rest)
  }
  if (text === "\x1b[") return true
  if (text === "\x1b") return true
  return false
}

function decodeSgrMouse(button: number, x: number, y: number, _release: boolean): MouseWheelEvent | undefined {
  // SGR mouse button values: 4 = wheel up, 5 = wheel down.
  // Some terminals (e.g., xterm) encode wheel events as 64 = wheel up and
  // 65 = wheel down, with modifier bits (shift=4, meta=8, ctrl=16) added.
  // We accept both conventions, masking out the modifier bits for the 64/65
  // case and the low 3 bits for the 4/5 case.
  const wheelButton = button & 7
  const baseButton = button & ~0x1c
  if (wheelButton === 4 || baseButton === 64) return { direction: "up", x, y }
  if (wheelButton === 5 || baseButton === 65) return { direction: "down", x, y }
  return undefined
}
