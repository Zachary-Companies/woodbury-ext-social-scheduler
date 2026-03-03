# Instagram Posting Flow

## Prerequisites
- Chrome open with Instagram logged in
- Post content ready (text and at least one image — Instagram requires images)

## Login Check
```
Navigate to: https://www.instagram.com/
browser_query(action="find_interactive", description="profile avatar or user menu in navigation")
→ If login form appears instead, STOP and tell the user to log in first
```

## Steps

### 1. Navigate to Instagram
```
Navigate to: https://www.instagram.com/
Wait for feed to load (look for posts or the navigation sidebar)
```

### 2. Open Create Post Dialog
```
browser_query(action="find_interactive", description="Create new post button in the left sidebar")
→ Look for: aria-label containing "New post" or "Create" in the sidebar nav
→ Click it with mouse tool
Wait for "Create new post" dialog to appear: browser_query(action="wait_for_element", selector="[role='dialog']")
```

### 3. Upload Image
```
In the dialog, find "Select from computer" button or the drag-drop area
browser_query(action="find_interactive", description="Select from computer button")
→ Click it to open OS file dialog
file_dialog(filePath="<absolute_path_to_image>")
Wait 3-5 seconds for the image to upload and show preview
```

### 4. Skip Crop & Filters
```
Click "Next" button (top right of dialog) to skip the crop step
browser_query(action="find_interactive", description="Next button")
→ Click it
Wait for filters page to appear
Click "Next" again to skip filters
→ Click the Next button again
Wait for the caption/share page to appear
```

### 5. Enter Caption
```
Find the caption textarea:
browser_query(action="find_interactive", description="Write a caption textarea")
→ Click it to focus
keyboard(action="type", text="<post_text_with_hashtags>")
```

### 6. Share/Publish
```
Find the Share button:
browser_query(action="find_interactive", description="Share button to publish the post")
→ Click it
Wait 5-10 seconds for upload to complete
```

### 7. Verify Success
```
Look for "Your post has been shared" text or similar success indication
browser_query(action="find_element_by_text", text="shared")
OR check if the dialog closed and you're back on the feed
```

## Error Recovery
- If "Select from computer" not found: the dialog might show differently, try browser_query(action="get_clickable_elements") to see what's available
- If Next button is disabled: the image may still be processing, wait and retry
- If Share button is disabled: check for error text in the dialog
- If CAPTCHA appears: STOP and alert the user — mark post as failed
- If upload seems stuck: wait up to 30 seconds, then dismiss and retry

## Quirks & Timing
- Instagram REQUIRES at least one image — text-only posts are not supported
- After image upload, there's a processing delay (2-5 seconds)
- The dialog has 3 steps: Select/Crop → Filters → Caption/Share
- Caption limit is 2,200 characters
- Maximum 10 images per carousel post (single image is most reliable for automation)
- Hashtags go in the caption text — Instagram allows up to 30 per post
- The Create button might be an icon (camera or + icon) without text — use aria-label to find it
