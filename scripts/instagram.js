/**
 * Instagram Posting Script
 *
 * Deterministic step sequence for posting to Instagram via browser automation.
 * Bridge-capable steps execute directly; agent-required steps pause for
 * the LLM to execute one MCP call.
 *
 * Flow: Navigate → Login check → Create → Upload image → Crop → Filters → Caption → Share → Verify
 */

module.exports = {
  platform: 'instagram',
  requiresImage: true,
  maxCaptionLength: 2200,

  steps: [
    // ── Step 1: Navigate to Instagram ──
    {
      type: 'navigate',
      url: 'https://www.instagram.com/',
      waitMs: 4000,
      label: 'Navigate to Instagram',
    },

    // ── Step 2: Login check ──
    {
      type: 'checkpoint',
      label: 'login_check',
      bridge: {
        action: 'find_element_by_text',
        params: { text: 'Log in', tag: 'button' },
      },
      failIf: 'found',
      failMessage: 'Not logged into Instagram. Please log in manually in Chrome first, then try again.',
    },

    // ── Step 3: Click Create button ──
    {
      type: 'bridge',
      action: 'find_interactive',
      params: { description: 'Create new post button in sidebar' },
      then: 'click',
      retry: { count: 2, delayMs: 2000 },
      fallback: [
        { action: 'find_element_by_text', params: { text: 'Create' } },
      ],
      label: 'Click Create button',
    },

    // ── Step 4: Wait for Create dialog ──
    {
      type: 'bridge',
      action: 'wait_for_element',
      params: { selector: '[role="dialog"]', timeout: 10000 },
      label: 'Wait for Create dialog',
    },

    // ── Step 5: Click "Select from computer" ──
    {
      type: 'bridge',
      action: 'find_element_by_text',
      params: { text: 'Select from computer', tag: 'button' },
      then: 'click',
      retry: { count: 2, delayMs: 2000 },
      label: 'Click Select from computer',
    },

    // ── Step 6: Select image via OS file dialog (AGENT STEP) ──
    {
      type: 'file_dialog',
      pathVar: 'imagePath',
      waitAfter: 3000,
      label: 'Select image file',
    },

    // ── Step 7: Wait for image to process ──
    {
      type: 'wait',
      ms: 4000,
      label: 'Wait for image processing',
    },

    // ── Step 8: Click Next (skip crop) ──
    {
      type: 'bridge',
      action: 'find_element_by_text',
      params: { text: 'Next', tag: 'button' },
      then: 'click',
      retry: { count: 3, delayMs: 2000 },
      label: 'Skip crop (Next)',
    },

    // ── Step 9: Wait for filters step ──
    {
      type: 'wait',
      ms: 1500,
      label: 'Wait for filters step',
    },

    // ── Step 10: Click Next (skip filters) ──
    {
      type: 'bridge',
      action: 'find_element_by_text',
      params: { text: 'Next', tag: 'button' },
      then: 'click',
      retry: { count: 2, delayMs: 1500 },
      label: 'Skip filters (Next)',
    },

    // ── Step 11: Wait for caption step ──
    {
      type: 'wait',
      ms: 1500,
      label: 'Wait for caption step',
    },

    // ── Step 12: Click caption textarea to focus it ──
    {
      type: 'bridge',
      action: 'find_interactive',
      params: { description: 'Write a caption textarea' },
      then: 'click',
      retry: { count: 2, delayMs: 1500 },
      fallback: [
        { action: 'find_elements', params: { selector: 'textarea' } },
      ],
      label: 'Focus caption textarea',
    },

    // ── Step 13: Type caption text (AGENT STEP) ──
    {
      type: 'keyboard_type',
      textVar: 'captionText',
      waitAfter: 500,
      label: 'Type caption',
    },

    // ── Step 14: Click Share ──
    {
      type: 'bridge',
      action: 'find_element_by_text',
      params: { text: 'Share', tag: 'button' },
      then: 'click',
      retry: { count: 2, delayMs: 1500 },
      label: 'Click Share',
    },

    // ── Step 15: Wait for upload ──
    {
      type: 'wait',
      ms: 10000,
      label: 'Wait for upload to complete',
    },

    // ── Step 16: Verify success ──
    {
      type: 'checkpoint',
      label: 'verify_success',
      bridge: {
        action: 'find_element_by_text',
        params: { text: 'shared' },
      },
      failIf: 'not_found',
      failMessage: 'Could not confirm post was shared. Check Instagram to verify the result.',
    },
  ],
};
