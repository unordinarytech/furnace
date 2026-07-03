/**
 * Clipboard image extraction for macOS, Windows, Linux, and WSL2.
 * 
 * Based on Hermes Agent's clipboard.py implementation.
 * Uses platform-specific tools to extract images from system clipboard.
 */

import { exec, execSync } from "node:child_process"
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs"
import { promisify } from "node:util"
import { platform } from "node:os"
import { dirname } from "node:path"

const execAsync = promisify(exec)

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Extract an image from the system clipboard and save it as PNG.
 * Returns true if an image was found and saved.
 */
export async function saveClipboardImage(destPath: string): Promise<boolean> {
  const dir = dirname(destPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  const platformName = platform()
  
  if (platformName === "darwin") {
    return await macOSSave(destPath)
  }
  
  if (platformName === "win32") {
    return await windowsSave(destPath)
  }
  
  // Linux / WSL
  return await linuxSave(destPath)
}

/**
 * Quick check: does the clipboard currently contain an image?
 */
export async function hasClipboardImage(): Promise<boolean> {
  const platformName = platform()
  
  if (platformName === "darwin") {
    return await macOSHasImage()
  }
  
  if (platformName === "win32") {
    return await windowsHasImage()
  }
  
  // Linux / WSL
  return await linuxHasImage()
}

// ── macOS ────────────────────────────────────────────────────────────────

async function macOSSave(dest: string): Promise<boolean> {
  // Try pngpaste first (fast, handles more formats), fall back to osascript
  return (await macOSPngpaste(dest)) || (await macOSOsascript(dest))
}

async function macOSHasImage(): Promise<boolean> {
  try {
    const { stdout } = await execAsync('osascript -e "clipboard info"', { timeout: 3000 })
    return stdout.includes("«class PNGf»") || stdout.includes("«class TIFF»")
  } catch {
    return false
  }
}

async function macOSPngpaste(dest: string): Promise<boolean> {
  try {
    execSync(`pngpaste "${dest}"`, { timeout: 3000, stdio: "ignore" })
    return existsSync(dest)
  } catch {
    return false
  }
}

async function macOSOsascript(dest: string): Promise<boolean> {
  if (!(await macOSHasImage())) {
    return false
  }

  const script = `
try
  set imgData to the clipboard as «class PNGf»
  set f to open for access POSIX file "${dest}" with write permission
  write imgData to f
  close access f
on error
  return "fail"
end try
`

  try {
    const { stdout } = await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 5000 })
    return !stdout.includes("fail") && existsSync(dest)
  } catch {
    return false
  }
}

// ── Windows ──────────────────────────────────────────────────────────────

const PS_CHECK_IMAGE = 
  "Add-Type -AssemblyName System.Windows.Forms;" +
  "[System.Windows.Forms.Clipboard]::ContainsImage()"

const PS_EXTRACT_IMAGE = 
  "Add-Type -AssemblyName System.Windows.Forms;" +
  "Add-Type -AssemblyName System.Drawing;" +
  "$img = [System.Windows.Forms.Clipboard]::GetImage();" +
  "if ($null -eq $img) { exit 1 };" +
  "$ms = New-Object System.IO.MemoryStream;" +
  "$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png);" +
  "[System.Convert]::ToBase64String($ms.ToArray())"

async function windowsHasImage(): Promise<boolean> {
  const ps = findPowerShell()
  if (!ps) return false

  try {
    const { stdout } = await execAsync(`${ps} -NoProfile -NonInteractive -Command "${PS_CHECK_IMAGE}"`, { timeout: 5000 })
    return stdout.trim() === "True"
  } catch {
    return false
  }
}

async function windowsSave(dest: string): Promise<boolean> {
  const ps = findPowerShell()
  if (!ps) return false

  try {
    const { stdout } = await execAsync(`${ps} -NoProfile -NonInteractive -Command "${PS_EXTRACT_IMAGE}"`, { timeout: 15000 })
    const b64Data = stdout.trim()
    if (!b64Data) return false

    const imageBytes = Buffer.from(b64Data, "base64")
    writeFileSync(dest, imageBytes)
    return existsSync(dest)
  } catch {
    return false
  }
}

function findPowerShell(): string | null {
  for (const name of ["powershell", "pwsh"]) {
    try {
      execSync(`${name} -NoProfile -NonInteractive -Command "echo ok"`, { timeout: 5000, stdio: "pipe" })
      return name
    } catch {
      continue
    }
  }
  return null
}

// ── Linux / WSL ──────────────────────────────────────────────────────────

async function linuxSave(dest: string): Promise<boolean> {
  // Try WSL first
  if (isWSL() && await wslSave(dest)) {
    return true
  }

  // Try Wayland
  if (process.env.WAYLAND_DISPLAY && await waylandSave(dest)) {
    return true
  }

  // Fall back to X11
  return await xclipSave(dest)
}

async function linuxHasImage(): Promise<boolean> {
  if (isWSL() && await wslHasImage()) {
    return true
  }

  if (process.env.WAYLAND_DISPLAY && await waylandHasImage()) {
    return true
  }

  return await xclipHasImage()
}

function isWSL(): boolean {
  try {
    const release = execSync("uname -r", { encoding: "utf8", stdio: "pipe" })
    return release.toLowerCase().includes("microsoft") || release.toLowerCase().includes("wsl")
  } catch {
    return false
  }
}

async function wslHasImage(): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`powershell.exe -NoProfile -NonInteractive -Command "${PS_CHECK_IMAGE}"`, { timeout: 8000 })
    return stdout.trim() === "True"
  } catch {
    return false
  }
}

async function wslSave(dest: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`powershell.exe -NoProfile -NonInteractive -Command "${PS_EXTRACT_IMAGE}"`, { timeout: 15000 })
    const b64Data = stdout.trim()
    if (!b64Data) return false

    const imageBytes = Buffer.from(b64Data, "base64")
    writeFileSync(dest, imageBytes)
    return existsSync(dest)
  } catch {
    return false
  }
}

async function waylandHasImage(): Promise<boolean> {
  try {
    const { stdout } = await execAsync("wl-paste --list-types", { timeout: 3000 })
    return stdout.split("\n").some(t => t.startsWith("image/"))
  } catch {
    return false
  }
}

async function waylandSave(dest: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync("wl-paste --list-types", { timeout: 3000 })
    const types = stdout.split("\n")

    // Prefer PNG, fall back to other formats
    let mime: string | undefined
    for (const preferred of ["image/png", "image/jpeg", "image/bmp", "image/gif", "image/webp"]) {
      if (types.includes(preferred)) {
        mime = preferred
        break
      }
    }

    if (!mime) return false

    execSync(`wl-paste --type ${mime} > "${dest}"`, { timeout: 5000, stdio: "ignore" })
    return existsSync(dest)
  } catch {
    return false
  }
}

async function xclipHasImage(): Promise<boolean> {
  try {
    const { stdout } = await execAsync('xclip -selection clipboard -t TARGETS -o', { timeout: 3000 })
    return stdout.includes("image/png")
  } catch {
    return false
  }
}

async function xclipSave(dest: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync('xclip -selection clipboard -t TARGETS -o', { timeout: 3000 })
    if (!stdout.includes("image/png")) {
      return false
    }

    execSync(`xclip -selection clipboard -t image/png -o > "${dest}"`, { timeout: 5000, stdio: "ignore" })
    return existsSync(dest)
  } catch {
    return false
  }
}
