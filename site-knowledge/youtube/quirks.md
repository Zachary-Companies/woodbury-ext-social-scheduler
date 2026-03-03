# YouTube Studio Quirks

## Upload Behavior
- YouTube auto-fills the title from the video filename — must select all + replace
- Upload continues in background while you fill in details
- Large videos may take a while to process even after upload completes
- If processing isn't done when you hit Publish, it queues and publishes once ready

## Shorts Detection
- Videos under 60 seconds in vertical aspect ratio (9:16) are auto-detected as Shorts
- YouTube may show a different UI for Shorts uploads
- Shorts have a different title length limit (100 chars) but same upload flow

## Common Issues
- The "Next" button may be disabled if required fields aren't filled
- "Made for kids" selection is REQUIRED — you cannot proceed without selecting one
- Sometimes YouTube Studio shows a "Checks" step that may flag copyright claims
- If a copyright claim is detected, the video can still be published but may have restrictions

## Timing
- After selecting file: wait 5s for upload to initialize
- After typing title/description: wait 500ms for autosave
- Between Next clicks: wait 1.5s for page transitions
- After Publish: wait 8s for confirmation dialog
