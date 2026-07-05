import process from "node:process"

const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h"
const MOUSE_DISABLE = "\x1b[?1000l\x1b[?1006l"

export function enableMouseTracking(): void {
  if (process.stdout.isTTY) process.stdout.write(MOUSE_ENABLE)
}

export function disableMouseTracking(): void {
  if (process.stdout.isTTY) process.stdout.write(MOUSE_DISABLE)
}

export type WheelDirection = "up" | "down"

export type MouseWheelEvent = {
  direction: WheelDirection
  x: number
  y: number
}

type WheelCallback = (event: MouseWheelEvent) => void

export class MouseInput {
  private callback?: WheelCallback
  private onData: (data: Buffer) => void

  constructor() {
    this.onData = (data: Buffer) => {
      this.parse(data)
    }
  }

  start(): void {
    process.stdin.on("data", this.onData)
  }

  stop(): void {
    process.stdin.off("data", this.onData)
  }

  onWheel(callback: WheelCallback): void {
    this.callback = callback
  }

  private parse(data: Buffer): void {
    const text = data.toString("utf8")
    let index = 0
    while (index < text.length) {
      const sequence = matchSgrMouseSequence(text, index)
      if (!sequence) {
        index += 1
        continue
      }
      index = sequence.nextIndex
      const event = decodeSgrMouse(sequence.button, sequence.x, sequence.y, sequence.release)
      if (event) this.callback?.(event)
    }
  }
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

function decodeSgrMouse(button: number, x: number, y: number, release: boolean): MouseWheelEvent | undefined {
  // SGR mouse button values: 4 = wheel up, 5 = wheel down.
  // Wheel events are normally reported as release ('m'), but accept press ('M') too.
  if (button === 4) return { direction: "up", x, y }
  if (button === 5) return { direction: "down", x, y }
  return undefined
}
