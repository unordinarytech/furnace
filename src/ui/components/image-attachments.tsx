import { Box, Text } from "ink"
import * as React from "react"
import type { ImageAttachment } from "../../utils/images.js"
import { useTheme } from "./theme-provider.js"

export type ImageAttachmentsProps = {
  images: ImageAttachment[]
  onRemove?: (id: string) => void
}

export function ImageAttachments({ images, onRemove }: ImageAttachmentsProps): React.ReactNode {
  const theme = useTheme()

  if (images.length === 0) return null

  return (
    <Box flexDirection="column" gap={0} marginBottom={1}>
      <Box>
        <Text color={theme.colors.mutedForeground}>{images.length} image{images.length === 1 ? "" : "s"} attached:</Text>
      </Box>
      {images.map((img, index) => (
        <Box key={img.id} gap={1}>
          <Text color={theme.colors.accent}>📎</Text>
          <Text color={theme.colors.foreground}>
            {img.displayName || `Image ${index + 1}`}
            {img.size ? ` (${formatBytes(img.size)})` : ""}
          </Text>
          {onRemove ? (
            <Text dimColor> [x to remove]</Text>
          ) : null}
        </Box>
      ))}
    </Box>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
