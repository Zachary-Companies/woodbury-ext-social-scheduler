/**
 * Twitter/X Posting Script
 *
 * Deterministic step sequence for posting to Twitter/X via browser automation.
 * Text-only posts are supported (unlike Instagram).
 *
 * Flow: Navigate → Login check → Compose → Type text → (Upload image) → Post → Verify
 */

module.exports = {
  platform: 'twitter',
  requiresImage: false,
  maxTextLength: 280,  // free tier; Premium is 25000

  steps: [
    // ── Step 1: Navigate to Twitter ──
    {
      type: 'navigate',
      url: 'https://x.com/home',
      waitMs: 4000,
      label: 'Navigate to Twitter/X',
    },

    // ── Step 2: Login check ──
    {
      type: 'checkpoint',
      label: 'login_check',
      bridge: {
        action: 'find_element_by_text',
        params: { text: 'Sign in', tag: 'a' },
      },
      failIf: 'found',
      failMessage: 'Not logged into Twitter/X. Please log in manually in Chrome first, then try again.',
    },

    // ── Step 3: Click compose area ──
    {
      type: 'bridge',
      action: 'find_interactive',
      params: { description: 'compose tweet text area or What is happening input' },
      then: 'click',
      retry: { count: 3, delayMs: 2000 },
      fallback: [
        { action: 'find_elements', params: { selector: '[data-testid="tweetTextarea_0"]' } },
        { action: 'find_interactive', params: { description: 'compose new post floating button' } },
      ],
      label: 'Click compose area',
    },

    // ── Step 4: Wait for compose to be ready ──
    {
      type: 'wait',
      ms: 1000,
      label: 'Wait for compose to focus',
    },

    // ── Step 5: Type post text (AGENT STEP) ──
    {
      type: 'keyboard_type',
      textVar: 'postText',
      waitAfter: 500,
      label: 'Type post text',
    },

    // ── Step 6: Upload image if available (conditional) ──
    // This step is skipped at runtime if no image is available.
    // The engine's variable resolver checks for imagePath.
    {
      type: 'bridge',
      action: 'find_interactive',
      params: { description: 'add photos or video media upload button' },
      then: 'click',
      retry: { count: 2, delayMs: 1500 },
      fallback: [
        { action: 'find_elements', params: { selector: '[data-testid="fileInput"]' } },
      ],
      label: 'Click media upload button',
      conditional: 'hasImage',
    },

    // ── Step 7: Select image via OS file dialog (AGENT STEP, conditional) ──
    {
      type: 'file_dialog',
      pathVar: 'imagePath',
      waitAfter: 3000,
      label: 'Select image file',
      conditional: 'hasImage',
    },

    // ── Step 8: Wait for image upload ──
    {
      type: 'wait',
      ms: 3000,
      label: 'Wait for image upload',
      conditional: 'hasImage',
    },

    // ── Step 9: Click Post button ──
    {
      type: 'bridge',
      action: 'find_element_by_text',
      params: { text: 'Post', tag: 'button' },
      then: 'click',
      retry: { count: 2, delayMs: 1500 },
      fallback: [
        { action: 'find_elements', params: { selector: '[data-testid="tweetButtonInline"]' } },
        { action: 'find_elements', params: { selector: '[data-testid="tweetButton"]' } },
      ],
      label: 'Click Post button',
    },

    // ── Step 10: Wait for post to publish ──
    {
      type: 'wait',
      ms: 4000,
      label: 'Wait for post to publish',
    },

    // ── Step 11: Verify success ──
    {
      type: 'checkpoint',
      label: 'verify_success',
      bridge: {
        action: 'find_element_by_text',
        params: { text: 'Your post was sent' },
      },
      failIf: 'not_found',
      failMessage: 'Could not confirm post was sent. Check Twitter/X to verify the result.',
    },
  ],
};
