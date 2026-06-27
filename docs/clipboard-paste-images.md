# Clipboard Image Pasting

Furnace supports pasting images directly from your system clipboard, just like Hermes Agent. This is the fastest way to attach screenshots, diagrams, or any image you've copied.

## Quick Start

1. **Copy an image to clipboard** (screenshot, image from browser, etc.)
2. **In Furnace prompt, press:**
   - **Cmd+V** (macOS)
   - **Ctrl+V** (Windows/Linux)
   - **Alt+V** (universal - works everywhere)
3. **Image auto-attaches** and shows as "Image 1", "Image 2", etc.
4. **Type your prompt** and submit

## How It Works

When you paste with an empty clipboard buffer (no text), Furnace automatically checks your system clipboard for image data. If found, it:

1. Saves the image to `.furnace/images/clip_TIMESTAMP_counter.png`
2. Converts to base64 for API transmission
3. Displays preview in the prompt area
4. Attaches to your next message

## Keyboard Shortcuts

### Empty Paste (Image Only)
When you paste **without** any text in clipboard:
- **Cmd+V / Ctrl+V** → Auto-attaches clipboard image
- **Alt+V** → Explicitly checks for clipboard image

### Text + Image Paste
When you paste **with** text in clipboard:
- Text inserts normally
- Image is **not** auto-attached (prevents accidental duplicates)
- Use `/image` command or Alt+V to attach image separately

## Platform Support

### macOS
✅ **Always works** - Uses built-in `osascript`  
✅ **Enhanced with pngpaste** - `brew install pngpaste` for faster extraction  
✅ **Cmd+V** in Terminal.app, iTerm2, VSCode, all terminals

**Formats:** PNG, TIFF automatically converted to PNG

### Windows (Native)
✅ **PowerShell 5.1** - Built into Windows  
✅ **Ctrl+V** in Windows Terminal, cmd.exe, VSCode  
✅ **Alt+V** - Universal fallback

**Clipboard sources:**
- Screenshots (Win+Shift+S)
- Snipping Tool
- Copy image from browser
- Copy file in Explorer

### WSL2
✅ **powershell.exe** bridge to Windows clipboard  
✅ **Alt+V** - Most reliable method  
✅ **Ctrl+V** - May work depending on terminal

**Note:** WSL2 accesses the Windows clipboard, so Windows clipboard tools work

### Linux (X11)
✅ **xclip** - `sudo apt install xclip`  
✅ **Alt+V** recommended  
✅ **Ctrl+V** on some terminals (GNOME Terminal, Konsole)

**Formats:** PNG from clipboard

### Linux (Wayland)
✅ **wl-paste** - `sudo apt install wl-clipboard`  
✅ **Alt+V** recommended  
✅ Supports PNG, JPEG, GIF, WebP

**Auto-conversion:** Non-PNG formats converted to PNG

## Visual Feedback

When you paste an image, Furnace shows:

```
📎 Image 1 (234.5 KB)
📎 Image 2 (1.2 MB)
2 images attached
> describe these screenshots
```

Images are **cleared after submission** to prevent accidental re-sending.

## Comparison with Other Tools

### Furnace (This Implementation)
- ✅ Paste detection on empty clipboard
- ✅ Auto-saves to `.furnace/images/`
- ✅ Shows "Image 1", "Image 2" labels
- ✅ Alt+V universal paste shortcut
- ✅ Platform-native clipboard access

### Hermes Agent
- ✅ Same paste detection logic
- ✅ Saves to `~/.hermes/images/`
- ✅ Identical keyboard shortcuts
- ✅ Cross-platform clipboard support

### Claude Code
- ❌ No clipboard paste support (as of 2026)
- ✅ Drag & drop only

## Troubleshooting

### "Nothing happens when I paste"

**Check 1:** Is there actually an image in your clipboard?
```bash
# macOS - check clipboard contents
osascript -e "clipboard info"
# Should show: «class PNGf» or «class TIFF»

# Linux (X11) - check clipboard
xclip -selection clipboard -t TARGETS -o
# Should show: image/png

# Windows - check in PowerShell
powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::ContainsImage()"
# Should show: True
```

**Check 2:** Try **Alt+V** instead of Ctrl+V/Cmd+V  
Alt+V is the most reliable across all terminals and platforms.

**Check 3:** Check `.furnace/images/` directory
```bash
ls -la .furnace/images/
```
Images should appear here even if UI doesn't update.

### "Paste works but image doesn't appear"

This usually means the image was saved but UI didn't refresh. Try:
- Press Enter to submit (image should be attached)
- Check terminal refresh rate
- Look at `.furnace/images/` to confirm file

### "Wrong image attached"

**Cause:** Stale clipboard content  
**Solution:** Copy a new image before pasting

### Platform-Specific Issues

**macOS: "osascript failed"**
- osascript should always be available
- Check terminal permissions in System Preferences → Security & Privacy

**Windows: "PowerShell not found"**
- PowerShell 5.1 ships with Windows
- Try `powershell -Version` to check

**WSL2: "No clipboard access"**
- Ensure WSL2 (not WSL1): `wsl -l -v`
- Windows clipboard bridge should work automatically

**Linux: "xclip/wl-paste not installed"**
```bash
# X11
sudo apt install xclip

# Wayland
sudo apt install wl-clipboard
```

## Implementation Details

Furnace uses the same clipboard extraction strategy as Hermes Agent:

### macOS
1. Try `pngpaste` (if installed)
2. Fall back to `osascript` (always available)

### Windows
1. PowerShell + System.Windows.Forms.Clipboard
2. WinForms GetImage() → PNG via MemoryStream
3. Base64 encode → save

### WSL2
1. `powershell.exe` bridge to Windows clipboard
2. Same PowerShell extraction as native Windows

### Linux (Wayland)
1. `wl-paste --list-types` to check formats
2. Extract PNG (or convert from JPEG/GIF/WebP)
3. Save to file

### Linux (X11)
1. `xclip -selection clipboard -t TARGETS -o` to check
2. Extract image/png type
3. Save to file

## Technical Notes

- **No external dependencies** - Uses only OS-provided tools
- **Asynchronous** - Doesn't block the UI while checking clipboard
- **Silent failure** - No error if clipboard empty (UX choice)
- **Auto-cleanup** - Images cleared after message sent
- **Base64 encoding** - For API transmission
- **SQLite storage** - Images persist in session database

## Best Practices

1. **Use Alt+V for reliability** - Works everywhere
2. **Copy fresh** - Don't rely on stale clipboard content
3. **Check preview** - Verify correct image attached before sending
4. **One paste = one image** - Paste multiple times for multiple images
5. **Clear before submit** - Remove unwanted images with `/image` command

## Future Enhancements

Potential improvements:
- [ ] Remove individual images from UI
- [ ] Drag & drop support
- [ ] Thumbnail preview in transcript
- [ ] Clipboard monitoring (continuous paste detection)
- [ ] Image compression before send
- [ ] Support for copied image files (not just raw image data)

---

**Bottom line:** Copy image, press Alt+V, see "Image 1" appear. That's it! 🎉
