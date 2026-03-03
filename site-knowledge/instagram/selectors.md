# Instagram Selectors

## Navigation (Sidebar)
| Element | Selector / Description | Notes |
|---------|----------------------|-------|
| Home | `a[href="/"]` or aria-label="Home" | Feed page |
| Search | aria-label="Search" | Opens search panel |
| Explore | `a[href="/explore/"]` | Discover content |
| Reels | `a[href="/reels/"]` | Short videos |
| Messages | `a[href="/direct/inbox/"]` | DMs |
| Notifications | aria-label="Notifications" | Heart icon |
| Create | aria-label containing "New post" or "Create" | + icon or camera icon |
| Profile | Links to `/<username>/` | Profile avatar in sidebar |

## Create Post Dialog
| Element | Selector / Description | Notes |
|---------|----------------------|-------|
| Dialog container | `[role="dialog"]` | The modal overlay |
| Select from computer | Button with text "Select from computer" | In initial step |
| Drag & drop area | Inside the dialog, above the button | Alternative upload |
| Next button | Button with text "Next" (top right) | Advances through steps |
| Back button | Button with aria-label containing "Back" | Go to previous step |
| Caption textarea | `textarea` inside the dialog, or aria-label "Write a caption" | Final step |
| Share button | Button with text "Share" | Publishes the post |
| Discard button | Button with text "Discard" | Abandon the post |

## Post Verification
| Element | Description | Notes |
|---------|-------------|-------|
| Success message | Text "Your post has been shared" or "Your reel has been shared" | Appears after publishing |
| Error message | Look for red text or alert elements inside dialog | Validation errors |

## Login Detection
| Indicator | How to Check | Notes |
|-----------|-------------|-------|
| Logged in | Profile avatar visible in sidebar navigation | |
| Not logged in | Login form with "Log in" button visible | Redirect to /accounts/login/ |
