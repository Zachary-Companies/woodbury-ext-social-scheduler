# YouTube Studio Selectors

## Upload Flow
- Create button: `#create-icon`, text "Create"
- Upload videos option: text "Upload videos"
- Select files button: `#select-files-button`, text "SELECT FILES"
- File input: `input[type="file"]`

## Video Details
- Title field: `#title-textarea #textbox`, `#textbox[aria-label*="title"]`
- Description field: `#description-textarea #textbox`
- Not made for kids: `[name="NOT_MADE_FOR_KIDS"]`, text "No, it's not made for kids"

## Navigation
- Next button: text "Next" (button)
- Publish button: text "Publish" (button), `#done-button`

## Visibility
- Public radio: `[name="PUBLIC"]`, text "Public"
- Unlisted radio: `[name="UNLISTED"]`, text "Unlisted"
- Private radio: `[name="PRIVATE"]`, text "Private"

## Verification
- Success indicator: text "published" in dialog
- Video link: appears in the success dialog after publish
