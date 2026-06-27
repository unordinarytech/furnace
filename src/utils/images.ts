import { readFile } from "node:fs/promises"
import { extname } from "node:path"

export type ImageSource =
  | { type: "base64"; media_type: string; data: string }
  | { type: "url"; url: string }

export type ImageAttachment = {
  id: string
  source: ImageSource
  displayName?: string
  size?: number
}

const SUPPORTED_FORMATS = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])
const MAX_IMAGE_SIZE = 5 * 1024 * 1024 // 5MB

const EXTENSION_TO_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

export function isImagePath(text: string): boolean {
  const ext = extname(text).toLowerCase()
  return ext in EXTENSION_TO_MIME
}

export function getImageMimeType(path: string): string | null {
  const ext = extname(path).toLowerCase()
  return EXTENSION_TO_MIME[ext] || null
}

export function isSupportedImageFormat(mimeType: string): boolean {
  return SUPPORTED_FORMATS.has(mimeType)
}

export function validateImageSize(sizeBytes: number): { valid: boolean; error?: string } {
  if (sizeBytes > MAX_IMAGE_SIZE) {
    return {
      valid: false,
      error: `Image size ${formatBytes(sizeBytes)} exceeds maximum of ${formatBytes(MAX_IMAGE_SIZE)}`,
    }
  }
  return { valid: true }
}

export async function loadImageAsBase64(filePath: string): Promise<{
  success: true
  source: ImageSource
  size: number
} | {
  success: false
  error: string
}> {
  try {
    const mimeType = getImageMimeType(filePath)
    if (!mimeType) {
      return { success: false, error: `Unsupported image format: ${extname(filePath)}` }
    }

    if (!isSupportedImageFormat(mimeType)) {
      return { success: false, error: `Image format ${mimeType} is not supported. Use JPEG, PNG, GIF, or WebP.` }
    }

    const buffer = await readFile(filePath)
    const size = buffer.length

    const validation = validateImageSize(size)
    if (!validation.valid) {
      return { success: false, error: validation.error! }
    }

    const base64 = buffer.toString("base64")

    return {
      success: true,
      source: {
        type: "base64",
        media_type: mimeType,
        data: base64,
      },
      size,
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function parseImageUrl(text: string): string | null {
  try {
    const url = new URL(text)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    const path = url.pathname.toLowerCase()
    if (!Object.keys(EXTENSION_TO_MIME).some(ext => path.endsWith(ext))) return null
    return url.href
  } catch {
    return null
  }
}

export function createImageAttachment(source: ImageSource, options?: { displayName?: string; size?: number }): ImageAttachment {
  return {
    id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    source,
    displayName: options?.displayName,
    size: options?.size,
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
