# Twitter/X Selectors

## Navigation
| Element | Selector / Description | Notes |
|---------|----------------------|-------|
| Home | `a[href="/home"]` | Feed page |
| Explore | `a[href="/explore"]` | Search/trending |
| Notifications | `a[href="/notifications"]` | Mentions, likes |
| Messages | `a[href="/messages"]` | DMs |
| Profile | `a[href="/<username>"]` | User profile |

## Compose
| Element | Selector / Description | Notes |
|---------|----------------------|-------|
| Compose box (top of feed) | `[data-testid="tweetTextarea_0"]` or contenteditable div | Inline compose |
| Floating compose button | `a[href="/compose/post"]` or aria-label="Post" | Blue circle button |
| Compose modal | `[role="dialog"]` | When using floating button |
| Text area in modal | `[data-testid="tweetTextarea_0"]` | Rich text editor (contenteditable) |
| Post/Tweet button | `[data-testid="tweetButtonInline"]` or `[data-testid="tweetButton"]` | Submit button |
| Media button | `[data-testid="fileInput"]` parent or aria-label containing "media" | Image upload |
| Character count | Near the Post button | Circle indicator |

## Post Verification
| Element | Description | Notes |
|---------|-------------|-------|
| Success toast | "Your post was sent" text in toast | Bottom of screen |
| Posted tweet | The new tweet appearing in feed | After page refresh |

## Login Detection
| Indicator | How to Check | Notes |
|-----------|-------------|-------|
| Logged in | Compose box or profile link visible | |
| Not logged in | Login button or "Sign in" text visible | Redirect to /login |
