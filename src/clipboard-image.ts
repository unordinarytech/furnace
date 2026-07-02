/**
 * Clipboard image reading utilities.
 *
 * Returns the clipboard image as a base64-encoded PNG string, or null if the
 * clipboard does not contain an image or the platform is unsupported.
 */

import { spawnSync } from "node:child_process"

export type ClipboardImage = {
  /** Base64-encoded PNG data (no data: URI prefix) */
  base64: string
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"
}

/**
 * Attempt to read an image from the system clipboard.
 * Returns null when the clipboard contains no image or on an unsupported platform.
 */
export function readClipboardImage(): ClipboardImage | null {
  if (process.platform === "darwin") return readClipboardImageMac()
  if (process.platform === "linux") return readClipboardImageLinux()
  return null
}

// ── macOS ──────────────────────────────────────────────────────────────────

const MAC_SCRIPT = `
tell application "System Events"
  try
    set imgData to the clipboard as «class PNGf»
    set b64 to do shell script "echo " & quoted form of (imgData as string) & " | xxd -r -p | base64"
    return b64
  end try
end tell
return ""
`

// Faster path: use Python's AppKit which is available on macOS and avoids
// the slow osascript startup for large images.
const MAC_PYTHON_SCRIPT = `
import sys, base64
try:
    from AppKit import NSPasteboard, NSPasteboardTypePNG, NSPasteboardTypeTIFF
    from PIL import Image
    import io
    pb = NSPasteboard.generalPasteboard()
    data = pb.dataForType_(NSPasteboardTypePNG) or pb.dataForType_(NSPasteboardTypeTIFF)
    if data:
        img = Image.open(io.BytesIO(bytes(data)))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        sys.stdout.buffer.write(base64.b64encode(buf.getvalue()))
except Exception:
    pass
`

function readClipboardImageMac(): ClipboardImage | null {
  // Try pngpaste (brew install pngpaste) first — fastest and most reliable
  const pngpaste = spawnSync("pngpaste", ["-"], { encoding: "buffer", timeout: 5000 })
  if (pngpaste.status === 0 && pngpaste.stdout?.length) {
    const b64 = pngpaste.stdout.toString("base64")
    if (b64.length > 0) return { base64: b64, mediaType: "image/png" }
  }

  // Fallback: pbpaste can't handle binary, use osascript to convert PNG from clipboard
  const result = spawnSync("osascript", ["-e", `
use framework "Foundation"
use framework "AppKit"

set pb to current application's NSPasteboard's generalPasteboard()
set types to pb's types() as list
if types contains "public.png" then
  set imgData to pb's dataForType:"public.png"
  set b64str to (current application's NSData's alloc()'s initWithData:imgData)'s base64EncodedStringWithOptions:0
  return b64str as text
end if
return ""
  `], { encoding: "utf8", timeout: 8000 })

  if (result.status === 0 && result.stdout) {
    const b64 = result.stdout.trim()
    if (b64.length > 10) return { base64: b64, mediaType: "image/png" }
  }

  return null
}

// ── Linux ──────────────────────────────────────────────────────────────────

function readClipboardImageLinux(): ClipboardImage | null {
  // xclip
  let result = spawnSync("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"], {
    encoding: "buffer",
    timeout: 5000,
  })
  if (result.status === 0 && result.stdout?.length) {
    return { base64: result.stdout.toString("base64"), mediaType: "image/png" }
  }

  // xsel doesn't support image types; wl-paste (Wayland)
  result = spawnSync("wl-paste", ["--type", "image/png"], { encoding: "buffer", timeout: 5000 })
  if (result.status === 0 && result.stdout?.length) {
    return { base64: result.stdout.toString("base64"), mediaType: "image/png" }
  }

  return null
}
