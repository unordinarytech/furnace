# Image Support

Furnace supports multi-image input following Anthropic's vision API patterns. You can attach images to your prompts to enable multimodal interactions with Claude.

## Supported Image Formats

- **JPEG** (`.jpg`, `.jpeg`)
- **PNG** (`.png`)
- **GIF** (`.gif`)
- **WebP** (`.webp`)

## Image Size Limits

- Maximum size per image: **5 MB**
- Maximum images per message: **100** (API limit)

## How to Add Images

### Method 1: Reference File Paths in Your Prompt

Simply mention image files in your prompt. Furnace will detect image paths and automatically load them:

```bash
> analyze screenshot.png and tell me what UI improvements you suggest
```

### Method 2: Use the `/image` Command

Use the `/image` slash command to explicitly attach images:

```bash
> /image path/to/image.png
> /image https://example.com/diagram.jpg
```

The images will be queued for attachment to your next message.

### Method 3: Programmatic API

When using Furnace programmatically, pass images through the `images` parameter:

```typescript
import { loadImageAsBase64, createImageAttachment } from './utils/images.js'

const result = await loadImageAsBase64('./screenshot.png')
if (result.success) {
  const attachment = createImageAttachment(result.source, {
    displayName: 'screenshot.png',
    size: result.size
  })
  
  // Pass to terminal or message handler
  terminal.addImageAttachment(attachment)
}
```

## Image Sources

Furnace supports three image source types:

### Base64-Encoded Images
Images loaded from local files are automatically converted to base64:

```typescript
{
  type: "base64",
  media_type: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAA..."
}
```

### URL References
Images hosted online can be referenced by URL:

```typescript
{
  type: "url",
  url: "https://example.com/image.png"
}
```

## Storage

Images are stored in the session SQLite database as part of message entries:

```typescript
type MessageEntryData = {
  content: string
  images?: Array<{
    type: "base64" | "url"
    media_type?: string
    data?: string
    url?: string
  }>
  hidden?: boolean
  model?: string
  source?: string
}
```

## API Format

When sent to the model API, images are converted to Anthropic's multi-modal content format:

```json
{
  "role": "user",
  "content": [
    {
      "type": "text",
      "text": "What's in this image?"
    },
    {
      "type": "image",
      "source": {
        "type": "base64",
        "media_type": "image/png",
        "data": "iVBORw0KGgo..."
      }
    }
  ]
}
```

## UI Indicators

When images are attached, Furnace displays them in the prompt area:

```
📎 screenshot.png (234.5 KB)
📎 diagram.jpg (1.2 MB)
2 images attached
> analyze these images
```

## Error Handling

Furnace validates images before sending:

- **Unsupported format**: Returns error for BMP, TIFF, or other non-supported formats
- **File too large**: Warns when image exceeds 5 MB limit
- **File not found**: Reports missing file paths
- **Network errors**: Reports URL fetch failures

## Examples

### Single Image Analysis
```bash
> what's wrong with this error message in error.png?
```

### Multiple Images Comparison
```bash
> /image before.png
> /image after.png
> compare these two screenshots and describe the UI changes
```

### Mixed Content
```bash
> here's the design mockup in design.png - implement this as a React component
```

### URL-Based Images
```bash
> /image https://raw.githubusercontent.com/user/repo/main/diagram.png
> explain the architecture shown in this diagram
```

## Implementation Details

### Files Modified

- `src/session/types.ts` - Added `images` field to `MessageEntryData`
- `src/providers/types.ts` - Provider-neutral multimodal message and content-block types
- `src/session/context.ts` - Updated message conversion to handle multi-modal content
- `src/session/store.ts` - Added image attachment support to `appendMessage`
- `src/interactive-session-controller.ts` - Image-aware submission and session replay
- `src/ui/pi-terminal.ts` - Attachment state, prompt labels, and clipboard insertion
- `src/utils/clipboard.ts` - Cross-platform clipboard image extraction
- `src/utils/images.ts` - Image validation and loading utilities

### Key Functions

- `loadImageAsBase64(filePath)` - Load and validate local image file
- `isImagePath(text)` - Check if text is an image file path
- `createImageAttachment(source, options)` - Create attachment record
- `terminal.insertImageAttachment(source, options)` - Queue an image for the next message

## Future Enhancements

Potential improvements not yet implemented:

- Drag & drop image files into terminal
- Image thumbnail preview in transcript
- Batch image loading from directory
- Image URL auto-detection in prompts
- Compress large images automatically
- Support for PDF pages as images

## Troubleshooting

**"Image format not supported"**
- Ensure the image is JPEG, PNG, GIF, or WebP
- Convert BMP, TIFF, or other formats before using

**"Image size exceeds maximum"**
- Resize images to under 5 MB
- Use image compression tools

**"Cannot load image"**
- Check file path is correct and accessible
- Verify file permissions
- For URLs, ensure they're publicly accessible

**Images not appearing in prompt**
- Images are cleared after submission
- Use `/image` command to re-attach
- Check terminal image attachment display
