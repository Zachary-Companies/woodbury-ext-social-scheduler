# Twitter/X Posting Flow

## Prerequisites
- Chrome open with Twitter/X logged in
- Post content ready (text, optionally images)

## Login Check
```
Navigate to: https://x.com/home
browser_query(action="find_interactive", description="compose tweet or post button")
→ If redirected to login page, STOP and tell the user to log in first
```

## Steps

### 1. Navigate to Twitter
```
Navigate to: https://x.com/home
Wait for the home feed to load
```

### 2. Find and Click Compose
```
Option A: Click the compose tweet area at the top of the feed
browser_query(action="find_interactive", description="What is happening compose box or Post button")

Option B: Click the floating compose button (blue circle with + or feather icon)
browser_query(action="find_interactive", description="compose new post floating button")

→ Click it with mouse tool
Wait for the compose textarea to be focused/active
```

### 3. Enter Post Text
```
The compose box should already be focused after clicking it
keyboard(action="type", text="<post_text>")
```

### 4. Upload Image (if applicable)
```
Find the media/image upload button (camera or image icon below the compose box):
browser_query(action="find_interactive", description="add photos or video media button")
→ Click it to open OS file dialog
file_dialog(filePath="<absolute_path_to_image>")
Wait 3-5 seconds for upload (look for image preview in compose area)
```

### 5. Submit Post
```
Find the Post/Tweet button:
browser_query(action="find_interactive", description="Post button to publish the tweet")
→ Click it
Wait 2-3 seconds for the post to publish
```

### 6. Verify Success
```
Look for the post appearing in the feed, or a success toast/notification
browser_query(action="find_element_by_text", text="Your post was sent")
OR check that the compose box is now empty/closed
```

## Error Recovery
- If compose box not found: Twitter may have changed layout, try get_clickable_elements
- If Post button is disabled: check character count (may be over 280 limit)
- If image upload fails: wait and retry, or skip the image
- If rate limited: STOP and inform the user

## Quirks & Timing
- Twitter/X has rebranded — URLs may be twitter.com or x.com (both work)
- Character limit: 280 for free accounts, 25,000 for Premium
- Text-only posts are supported (unlike Instagram)
- Images: max 4 per post, supported formats: JPEG, PNG, GIF, WEBP
- The compose box at the top of the feed and the floating button both work
- There may be a "Who can reply?" dropdown — leave it at default unless specified
- Twitter shows character count near the Post button — useful for verification
