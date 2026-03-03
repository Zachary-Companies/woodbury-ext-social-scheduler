# Twitter/X Quirks & Notes

## Timing
- Page load: 2-3 seconds
- Image upload: 2-4 seconds
- Post submission: 1-2 seconds
- Toast notification duration: ~5 seconds

## Character Limits
- Free accounts: 280 characters
- Premium accounts: 25,000 characters
- URLs count as 23 characters regardless of length

## Image Requirements
- Max images per post: 4
- Supported formats: JPEG, PNG, GIF, WEBP
- Max file size: 5MB for images, 15MB for GIFs
- Recommended: 1200x675 (landscape), 1080x1080 (square)

## Known Issues
- Twitter/X uses x.com domain but twitter.com still redirects
- The compose box uses a contenteditable div, NOT a textarea
- Keyboard "type" action may not work reliably in contenteditable — use pasteText approach
- Cookie consent / privacy banners may appear on first visit
- "Who can reply?" dropdown defaults to "Everyone" — usually fine
- Blue checkmark verification prompts may appear as overlays

## Tips
- The inline compose box at the top of the feed is easier to interact with than the floating button modal
- data-testid attributes are the most reliable selectors on Twitter
- If typing doesn't work in the contenteditable area, try clicking first, then using keyboard(action="clear") before typing
