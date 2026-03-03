# Instagram Quirks & Notes

## Timing
- Page load: 2-3 seconds
- Image upload processing: 3-5 seconds (varies with file size)
- Post submission: 5-10 seconds
- Dialog transition animations: ~500ms between steps

## Character Limits
- Caption: 2,200 characters
- Hashtags: max 30 per post
- Username mentions: no hard limit but 20+ may flag spam filters

## Image Requirements
- Max images per post: 10 (carousel)
- Supported formats: JPEG, PNG
- Max file size: ~30MB
- Recommended: 1080x1080 (square), 1080x1350 (portrait), 1080x566 (landscape)
- Minimum: 320px on shortest side

## Known Issues
- Instagram may show cookie consent banner on first visit — dismiss it before proceeding
- The Create button location changes between desktop layouts (sidebar vs top bar)
- SPA navigation means page state changes without URL changes — use dialog detection
- Instagram aggressively detects automation — keep delays human-like
- Some accounts have "Professional dashboard" banner that shifts layout
- The "New post" button may show as just a "+" icon with no visible text — rely on aria-label

## Tips
- Use `find_interactive` with natural language descriptions rather than CSS selectors (UI changes frequently)
- Always verify the dialog step before acting (look for "Crop", "Filters", or caption textarea)
- If posting fails, the drafted content is lost — the dialog doesn't save drafts
- For multi-image posts: select all images in the file dialog at once (not supported by file_dialog — use single image)
