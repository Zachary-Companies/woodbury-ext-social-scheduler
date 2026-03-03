# [Platform Name] Posting Flow

## Prerequisites
- Chrome open with [platform] logged in
- Post content ready (text and/or images)

## Login Check
```
browser_query(action="get_page_info")
→ Look for indicators that the user is logged in (profile avatar, username in nav, etc.)
→ If not logged in, STOP and tell the user to log in first
```

## Steps

### 1. Navigate to Platform
```
Navigate to: [platform URL]
Wait for page to fully load
```

### 2. Open Create Post Dialog
```
browser_query(action="find_interactive", description="[Create/Compose button description]")
→ Click it with mouse tool
Wait for create dialog/form to appear
```

### 3. Upload Image (if applicable)
```
Find the image upload button/area
Click it to open OS file dialog
file_dialog(filePath="<absolute_path_to_image>")
Wait for upload to complete (look for preview/thumbnail)
```

### 4. Enter Post Text
```
Find the text/caption input field
Click to focus it
keyboard(action="type", text="<post_text>")
```

### 5. Submit Post
```
Find the submit/share/post button
Click it
Wait for confirmation (toast message, redirect, etc.)
```

### 6. Verify Success
```
Check for success indicators:
- Toast/notification saying "posted" or "shared"
- Redirect to the published post
- Post appearing in feed/profile
```

## Error Recovery
- If upload fails: dismiss dialog, retry from Step 2
- If submit button is disabled: check for validation errors
- If CAPTCHA appears: STOP and alert the user
- If network error: wait 5 seconds, retry once

## Selectors (fill in after research)
- Create button: [selector]
- Text input: [selector]
- Image upload: [selector]
- Submit button: [selector]
- Success indicator: [selector]

## Quirks & Timing
- [Note any platform-specific behaviors, delays, animations]
