
## Features

### 🖼️ Multi-Image Support (NEW!)
Furnace now supports sending images to Claude for vision-based interactions:

```bash
> /image screenshot.png
Added image: screenshot.png (234.5 KB)
> what UI improvements would you suggest?
```

**Key capabilities:**
- ✅ Attach multiple images per message
- ✅ Support for JPEG, PNG, GIF, WebP formats
- ✅ Local files (auto-converted to base64)
- ✅ Remote URLs (https://example.com/image.jpg)
- ✅ 5MB per-image validation
- ✅ Visual preview in terminal UI
- ✅ Persistent storage in session database

**Usage:**
```bash
# Single image
> /image diagram.png
> explain this architecture

# Multiple images
> /image before.png
> /image after.png
> compare these screenshots

# Remote image
> /image https://picsum.photos/400/300
> describe this image
```

See **[docs/image-support.md](docs/image-support.md)** for complete documentation.

### 🔧 Other Features
- **Tool calling**: File operations, shell commands, web search
- **Session persistence**: SQLite-based conversation history
- **Compaction**: Automatically summarize old context
- **Plan mode**: Multi-step planning workflows
- **Subagents**: Delegate tasks to child sessions
- **Skills system**: Load and use custom skill definitions
- **Model selection**: Switch between different AI models
- **Approval gates**: Safe default permissions for sensitive operations

