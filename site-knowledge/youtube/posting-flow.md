# YouTube Video Upload Flow

## Prerequisites
- User must be logged into YouTube Studio in Chrome
- Video file must exist on disk (MP4 recommended)
- Title (max 100 chars) and description (max 5000 chars) prepared

## Steps

1. Navigate to `https://studio.youtube.com/`
2. Click the **Create** button (top-right area, camera icon with +)
3. Click **Upload videos** from the dropdown menu
4. Click **SELECT FILES** button in the upload dialog
5. Use file_dialog to select the video file from the OS picker
6. Wait for the video to start uploading/processing
7. Clear the auto-filled title and type the new title
8. Click the description field and type the description
9. Select **No, it's not made for kids** under audience
10. Click **Next** three times (Details -> Video Elements -> Checks -> Visibility)
11. Select **Public** for visibility
12. Click **Publish**
13. Wait for the confirmation dialog showing the video was published

## Important Notes
- YouTube may auto-fill the title from the filename — always clear it first
- The upload continues in the background while you fill in details
- If the video is still processing when you click Publish, YouTube will queue it
- Shorts (vertical video under 60s) are auto-detected by YouTube
