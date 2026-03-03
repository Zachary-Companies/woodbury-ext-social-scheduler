/**
 * YouTube Posting Script
 *
 * Deterministic step sequence for uploading a video to YouTube via browser automation.
 * Requires the user to be logged into YouTube Studio in Chrome.
 *
 * Flow: Navigate to Studio → Upload → Select video → Fill details → Visibility → Publish → Verify
 */

module.exports = {
  platform: 'youtube',
  requiresVideo: true,
  requiresImage: false,
  maxTitleLength: 100,
  maxDescriptionLength: 5000,

  steps: [
    // ── Step 1: Navigate to YouTube Studio upload ──
    {
      type: 'navigate',
      url: 'https://studio.youtube.com/',
      waitMs: 5000,
      label: 'Navigate to YouTube Studio',
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
      failMessage: 'Not logged into YouTube. Please log in to YouTube Studio in Chrome first, then try again.',
    },

    // ── Step 3: Click Upload / Create button ──
    {
      type: 'bridge',
      action: 'find_interactive',
      params: { description: 'Create or Upload videos button' },
      then: 'click',
      retry: { count: 3, delayMs: 2000 },
      fallback: [
        { action: 'find_element_by_text', params: { text: 'Upload videos', tag: 'span' } },
        { action: 'find_element_by_text', params: { text: 'CREATE', tag: 'button' } },
        { action: 'find_elements', params: { selector: '#create-icon' } },
      ],
      label: 'Click Create/Upload button',
    },

    // ── Step 4: Click "Upload videos" in dropdown if needed ──
    {
      type: 'wait',
      ms: 1500,
      label: 'Wait for upload menu',
    },

    {
      type: 'bridge',
      action: 'find_element_by_text',
      params: { text: 'Upload videos' },
      then: 'click',
      retry: { count: 2, delayMs: 1500 },
      label: 'Click Upload videos option',
    },

    // ── Step 5: Wait for upload dialog ──
    {
      type: 'bridge',
      action: 'wait_for_element',
      params: { selector: '#select-files-button, [id="select-files-button"], input[type="file"]', timeout: 10000 },
      label: 'Wait for upload dialog',
    },

    // ── Step 6: Click Select Files button ──
    {
      type: 'bridge',
      action: 'find_interactive',
      params: { description: 'Select files button to upload video' },
      then: 'click',
      retry: { count: 2, delayMs: 2000 },
      fallback: [
        { action: 'find_element_by_text', params: { text: 'SELECT FILES', tag: 'button' } },
        { action: 'find_element_by_text', params: { text: 'Select files', tag: 'button' } },
        { action: 'find_elements', params: { selector: '#select-files-button' } },
      ],
      label: 'Click Select Files',
    },

    // ── Step 7: Select video via OS file dialog (AGENT STEP) ──
    {
      type: 'file_dialog',
      pathVar: 'videoPath',
      waitAfter: 5000,
      label: 'Select video file',
    },

    // ── Step 8: Wait for video to start processing ──
    {
      type: 'wait',
      ms: 5000,
      label: 'Wait for video upload to begin',
    },

    // ── Step 9: Clear and type video title ──
    {
      type: 'bridge',
      action: 'find_interactive',
      params: { description: 'video title text input field' },
      then: 'click',
      retry: { count: 3, delayMs: 2000 },
      fallback: [
        { action: 'find_elements', params: { selector: '#textbox[aria-label="Add a title that describes your video (type @ to mention a channel)"]' } },
        { action: 'find_elements', params: { selector: '#title-textarea #textbox' } },
      ],
      label: 'Focus title field',
    },

    // ── Step 10: Select all existing title text and replace ──
    {
      type: 'keyboard_select_all',
      waitAfter: 300,
      label: 'Select existing title',
    },

    // ── Step 11: Type video title (AGENT STEP) ──
    {
      type: 'keyboard_type',
      textVar: 'titleText',
      waitAfter: 500,
      label: 'Type video title',
    },

    // ── Step 12: Click description field ──
    {
      type: 'bridge',
      action: 'find_interactive',
      params: { description: 'video description text input field' },
      then: 'click',
      retry: { count: 2, delayMs: 1500 },
      fallback: [
        { action: 'find_elements', params: { selector: '#description-textarea #textbox' } },
      ],
      label: 'Focus description field',
    },

    // ── Step 13: Type description (AGENT STEP) ──
    {
      type: 'keyboard_type',
      textVar: 'captionText',
      waitAfter: 500,
      label: 'Type video description',
    },

    // ── Step 14: Set "Not made for kids" ──
    {
      type: 'bridge',
      action: 'find_element_by_text',
      params: { text: 'No, it\'s not made for kids' },
      then: 'click',
      retry: { count: 2, delayMs: 1500 },
      fallback: [
        { action: 'find_elements', params: { selector: '[name="NOT_MADE_FOR_KIDS"]' } },
      ],
      label: 'Set not made for kids',
    },

    // ── Step 15: Click Next (details -> video elements) ──
    {
      type: 'bridge',
      action: 'find_element_by_text',
      params: { text: 'Next', tag: 'button' },
      then: 'click',
      retry: { count: 2, delayMs: 1500 },
      label: 'Next: skip video elements',
    },

    // ── Step 16: Wait ──
    {
      type: 'wait',
      ms: 1500,
      label: 'Wait for video elements step',
    },

    // ── Step 17: Click Next (video elements -> checks) ──
    {
      type: 'bridge',
      action: 'find_element_by_text',
      params: { text: 'Next', tag: 'button' },
      then: 'click',
      retry: { count: 2, delayMs: 1500 },
      label: 'Next: skip checks',
    },

    // ── Step 18: Wait ──
    {
      type: 'wait',
      ms: 1500,
      label: 'Wait for checks step',
    },

    // ── Step 19: Click Next (checks -> visibility) ──
    {
      type: 'bridge',
      action: 'find_element_by_text',
      params: { text: 'Next', tag: 'button' },
      then: 'click',
      retry: { count: 2, delayMs: 1500 },
      label: 'Next: to visibility',
    },

    // ── Step 20: Wait for visibility step ──
    {
      type: 'wait',
      ms: 1500,
      label: 'Wait for visibility step',
    },

    // ── Step 21: Select Public visibility ──
    {
      type: 'bridge',
      action: 'find_element_by_text',
      params: { text: 'Public' },
      then: 'click',
      retry: { count: 2, delayMs: 1500 },
      fallback: [
        { action: 'find_elements', params: { selector: '[name="PUBLIC"]' } },
      ],
      label: 'Set visibility to Public',
    },

    // ── Step 22: Click Publish ──
    {
      type: 'bridge',
      action: 'find_element_by_text',
      params: { text: 'Publish', tag: 'button' },
      then: 'click',
      retry: { count: 3, delayMs: 2000 },
      fallback: [
        { action: 'find_elements', params: { selector: '#done-button' } },
      ],
      label: 'Click Publish',
    },

    // ── Step 23: Wait for publish to complete ──
    {
      type: 'wait',
      ms: 8000,
      label: 'Wait for publish to complete',
    },

    // ── Step 24: Verify success ──
    {
      type: 'checkpoint',
      label: 'verify_success',
      bridge: {
        action: 'find_element_by_text',
        params: { text: 'published' },
      },
      failIf: 'not_found',
      failMessage: 'Could not confirm video was published. Check YouTube Studio to verify.',
    },
  ],
};
