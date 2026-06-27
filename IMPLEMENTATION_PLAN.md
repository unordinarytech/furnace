# Image Support Implementation Plan

## Overview
Add multi-image support to Furnace following Anthropic's vision API patterns.

## Technical Requirements

### 1. Data Model Changes
- Update `MessageEntryData` to support multi-modal content (text + images)
- Support three image source types:
  - Base64-encoded inline images
  - File paths (convert to base64 before API call)
  - URLs (pass through directly)

### 2. OpenRouter / Anthropic Message Format
```typescript
type ContentBlock = 
  | { type: "text", text: string }
  | { type: "image", source: { type: "base64", media_type: string, data: string } }
  | { type: "image", source: { type: "url", url: string } }

type OpenRouterMessage = {
  role: "user" | "assistant" | "system" | "tool"
  content: string | ContentBlock[]
  // ... other fields
}
```

### 3. User Input Flow
- Drag & drop images into terminal
- Paste images from clipboard
- Reference file paths in prompt (e.g., "analyze image.png ...")
- Support multiple images per message

### 4. UI Components
- Image attachment preview in prompt area
- Image thumbnails in transcript
- Remove attachment button
- File size validation (5MB per image limit)
- Format validation (JPEG, PNG, GIF, WebP)

### 5. CLI Integration
- Parse image references from user input
- Load image files and convert to base64
- Validate formats and sizes
- Store image data in session entries
- Display images in transcript

## Implementation Steps

1. ✅ Research Anthropic Vision API format
2. Update type definitions (types.ts, openrouter.ts)
3. Add image utilities (validation, base64 conversion)
4. Update message storage and conversion
5. Add UI components for image handling
6. Update CLI input processing
7. Add image display in transcript
8. Test with various image formats and sizes
9. Document usage

## File Changes Required

- `src/session/types.ts` - Update MessageEntryData
- `src/openrouter.ts` - Update OpenRouterMessage type
- `src/session/context.ts` - Update message conversion
- `src/session/store.ts` - Handle image storage
- `src/cli.ts` - Add image input handling
- `src/ui/components/prompt-input.tsx` - Add image attachment UI
- `src/ui/ink-terminal.tsx` - Add image display in transcript
- `src/utils/images.ts` - NEW: Image utilities
