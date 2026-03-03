/**
 * Workflow Runner — Bridge between Social Scheduler and Woodbury Workflows
 *
 * Discovers Woodbury workflow files (.workflow.json), maps social scheduler
 * post data to workflow variables, and executes them via the bridge server.
 *
 * Uses robotjs + flow-frame-core for OS-level mouse/keyboard control
 * (real, trusted input events) and the bridge for DOM queries and navigation.
 *
 * This module wraps the core Woodbury workflow engine concepts into a
 * simple interface that the social scheduler extension can use.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Diagnostic Logging ───────────────────────────────────────
const _CLICK_LOG_PATH = path.join(os.homedir(), '.woodbury', 'logs', 'click-debug.log');
function clickLog(msg, data) {
  try {
    fs.mkdirSync(path.dirname(_CLICK_LOG_PATH), { recursive: true });
    const ts = new Date().toISOString();
    let line = `[${ts}] ${msg}`;
    if (data !== undefined) {
      try { line += ' ' + JSON.stringify(data); } catch { line += ' [unserializable]'; }
    }
    fs.appendFileSync(_CLICK_LOG_PATH, line + '\n');
  } catch {}
}

// ── OS-Level Input (robotjs + flow-frame-core) ─────────────────
// These produce real, trusted OS input events (not synthetic JS events).
// Sites like Suno, Instagram, etc. cannot detect these as fake.
//
// These modules live in the main woodbury node_modules, not in the
// extension's node_modules. We resolve from known locations.

let robot = null;
let flowFrameOps = null;
let osInputAvailable = false;

function findWoodburyNodeModules() {
  // Try several known locations for the main woodbury installation
  const candidates = [
    path.join(os.homedir(), 'Documents', 'GitHub', 'woodbury', 'node_modules'),
    path.join(os.homedir(), 'Documents', 'GitHub', 'woodbury-mcp', 'node_modules'),
    // Also try the global npm prefix
    path.join(os.homedir(), '.woodbury', 'node_modules'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'robotjs'))) {
      return dir;
    }
  }
  return null;
}

try {
  // First try normal require (works if loaded from main woodbury process via require())
  robot = require('robotjs');
  flowFrameOps = require('flow-frame-core/dist/operations.js');
  osInputAvailable = true;
} catch {
  // Normal require failed — try resolving from woodbury's node_modules directly
  try {
    const nmDir = findWoodburyNodeModules();
    if (nmDir) {
      robot = require(path.join(nmDir, 'robotjs'));
      flowFrameOps = require(path.join(nmDir, 'flow-frame-core', 'dist', 'operations.js'));
      osInputAvailable = true;
    }
  } catch (err) {
    console.warn('[workflow-runner] robotjs/flow-frame-core not available, falling back to bridge for mouse/keyboard:', err.message);
  }
}

const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

// ── Chrome Offset Cache ────────────────────────────────────────
// The bridge returns viewport coordinates (relative to page content).
// To convert to screen coordinates for robotjs, we need Chrome's UI offset
// (toolbar height, window position, etc.).

let cachedChromeOffset = null;
let lastOffsetFetch = 0;
const OFFSET_CACHE_TTL = 3000; // 3 seconds — window can move, keep offsets fresh

async function getChromeOffset(bridge) {
  const now = Date.now();
  if (cachedChromeOffset && (now - lastOffsetFetch) < OFFSET_CACHE_TTL) {
    clickLog('getChromeOffset (cached)', cachedChromeOffset);
    return cachedChromeOffset;
  }
  try {
    const result = await bridge.send('ping', {});
    clickLog('getChromeOffset raw ping result.chromeOffset', result?.chromeOffset);
    if (result?.chromeOffset) {
      const co = result.chromeOffset;
      cachedChromeOffset = {
        x: co.totalOffsetX ?? (co.chromeUIWidth ?? 1),
        y: co.totalOffsetY ?? (co.chromeUIHeight ?? 125),
        dpr: co.devicePixelRatio || 1,
        raw: {
          windowX: co.windowX, windowY: co.windowY,
          chromeUIHeight: co.chromeUIHeight, chromeUIWidth: co.chromeUIWidth,
          totalOffsetX: co.totalOffsetX, totalOffsetY: co.totalOffsetY,
          innerWidth: co.innerWidth, innerHeight: co.innerHeight,
          outerWidth: co.outerWidth, outerHeight: co.outerHeight,
          screenWidth: co.screenWidth, screenHeight: co.screenHeight,
          devicePixelRatio: co.devicePixelRatio,
        },
      };
      lastOffsetFetch = now;
      clickLog('getChromeOffset computed', { x: cachedChromeOffset.x, y: cachedChromeOffset.y, dpr: cachedChromeOffset.dpr });
      return cachedChromeOffset;
    }
  } catch (err) {
    clickLog('getChromeOffset ERROR', { message: err?.message });
  }
  // Fallback defaults
  clickLog('getChromeOffset using FALLBACK defaults');
  return { x: 1, y: 125, dpr: 1 };
}

/**
 * Convert viewport coordinates (from bridge element positions) to
 * screen coordinates for robotjs.
 */
async function viewportToScreen(bridge, viewportX, viewportY) {
  const offset = await getChromeOffset(bridge);
  const result = {
    screenX: viewportX + offset.x,
    screenY: viewportY + offset.y,
  };
  clickLog('viewportToScreen', {
    input: { viewportX, viewportY },
    offset: { x: offset.x, y: offset.y, dpr: offset.dpr },
    output: result,
  });
  return result;
}

/**
 * Move mouse to screen coordinates using robotjs.
 */
function moveMouseTo(screenX, screenY, smooth = true) {
  if (smooth && !isWindows) {
    robot.moveMouseSmooth(screenX, screenY);
  } else {
    robot.moveMouse(screenX, screenY);
  }
}

/**
 * Click at current mouse position using flow-frame-core (most reliable).
 */
async function nativeClick() {
  await flowFrameOps.mouseClick();
}

/**
 * Get a fingerprint of the element at viewport coordinates (x, y) via the bridge.
 * Used for click verification — compare before/after to detect if a popup appeared.
 */
async function getElementFingerprint(bridge, vpX, vpY) {
  try {
    const result = await bridge.send('get_element_at_point', { x: vpX, y: vpY });
    return result?.fingerprint || null;
  } catch {
    return null;
  }
}

/**
 * Fire a single click at viewport coordinates using OS input or bridge fallback.
 */
async function performClick(bridge, vpX, vpY, clickAction, signal) {
  if (osInputAvailable) {
    const { screenX, screenY } = await viewportToScreen(bridge, vpX, vpY);
    moveMouseTo(screenX, screenY);
    if (clickAction === 'hover') {
      // Hover = move only, no click
      return;
    }
    await sleep(120, signal);
    if (clickAction === 'click') {
      await nativeClick();
    } else if (clickAction === 'double_click') {
      robot.mouseClick();
      await sleep(80, signal);
      robot.mouseClick();
    } else if (clickAction === 'right_click') {
      robot.mouseClick('right');
    }
  } else {
    // For bridge fallback, map 'hover' to the bridge's 'move' action
    const bridgeAction = clickAction === 'hover' ? 'move' : clickAction;
    await bridge.send('mouse', { action: bridgeAction, x: vpX, y: vpY });
  }
}

/**
 * Click at viewport coordinates and verify the DOM changed at that location.
 * Retries up to maxAttempts if the fingerprint at the click point doesn't change.
 */
async function clickWithVerification(bridge, vpX, vpY, clickAction, verifyOpts, signal) {
  const {
    enabled = false,
    maxAttempts = 3,
    verifyDelayMs = 400,
    retryDelayMs = 600,
  } = verifyOpts || {};

  // Snapshot fingerprint BEFORE clicking
  const fingerprintBefore = enabled ? await getElementFingerprint(bridge, vpX, vpY) : null;

  // First click
  await performClick(bridge, vpX, vpY, clickAction, signal);

  if (!enabled || fingerprintBefore === null) {
    return { attempts: 1, verified: null };
  }

  // Verify + retry loop
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(verifyDelayMs, signal);
    if (signal?.aborted) break;

    const fingerprintAfter = await getElementFingerprint(bridge, vpX, vpY);

    if (fingerprintAfter !== fingerprintBefore) {
      clickLog('clickWithVerification: DOM changed on attempt ' + attempt, {
        before: fingerprintBefore, after: fingerprintAfter
      });
      return { attempts: attempt, verified: true };
    }

    if (attempt < maxAttempts) {
      clickLog('clickWithVerification: no change, retrying (attempt ' + attempt + '/' + maxAttempts + ')');
      await sleep(retryDelayMs, signal);
      await performClick(bridge, vpX, vpY, clickAction, signal);
    }
  }

  clickLog('clickWithVerification: exhausted ' + maxAttempts + ' attempts, proceeding');
  return { attempts: maxAttempts, verified: false };
}

/**
 * Type text using robotjs (OS-level keystrokes).
 */
function nativeTypeString(text) {
  robot.typeString(text);
}

/**
 * Press a key with optional modifiers using robotjs.
 */
function nativeKeyTap(key, modifiers) {
  if (modifiers && modifiers.length > 0) {
    robot.keyTap(key, modifiers);
  } else {
    robot.keyTap(key);
  }
}

/**
 * Select-all and delete (clear a field) using robotjs.
 */
function nativeClear() {
  const modifier = isMac ? 'command' : 'control';
  robot.setKeyboardDelay(50);
  robot.keyTap('a', modifier);
  robot.keyTap('delete');
}

/**
 * Scroll using flow-frame-core.
 */
function nativeScroll(scrollX, scrollY) {
  flowFrameOps.scroll(scrollX, scrollY);
}

const GLOBAL_WORKFLOWS_DIR = path.join(os.homedir(), '.woodbury', 'workflows');
const EXTENSIONS_DIR = path.join(os.homedir(), '.woodbury', 'extensions');

// ── Discovery ──────────────────────────────────────────────────

/**
 * Discover all .workflow.json files from standard locations.
 * Returns array of { id, name, description, site, source, path, workflow }
 */
function discoverWorkflows(workingDirectory) {
  const results = [];

  // 1. Extension workflows
  if (fs.existsSync(EXTENSIONS_DIR)) {
    try {
      const entries = fs.readdirSync(EXTENSIONS_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'node_modules' || !entry.isDirectory()) continue;
        const wfDir = path.join(EXTENSIONS_DIR, entry.name, 'workflows');
        discoverFromDir(wfDir, 'extension', results, entry.name);
      }
    } catch {}
  }

  // 2. Project-local workflows
  if (workingDirectory) {
    const projectDir = path.join(workingDirectory, '.woodbury-work', 'workflows');
    discoverFromDir(projectDir, 'project', results);
  }

  // 3. Global workflows
  discoverFromDir(GLOBAL_WORKFLOWS_DIR, 'global', results);

  return results;
}

function discoverFromDir(dir, source, results, extensionName) {
  if (!fs.existsSync(dir)) return;
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.workflow.json'));
    for (const file of files) {
      try {
        const filePath = path.join(dir, file);
        const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (!content.version || !content.id || !content.name || !Array.isArray(content.steps)) continue;
        results.push({
          id: content.id,
          name: content.name,
          description: content.description || '',
          site: content.site || '',
          source,
          extensionName: extensionName || null,
          path: filePath,
          workflow: content,
        });
      } catch {}
    }
  } catch {}
}

// ── Variable Mapping ───────────────────────────────────────────

/**
 * Map social scheduler post data to workflow variables.
 *
 * Post data fields:
 *   - text (string): post caption / content text
 *   - imagePath (string): absolute path to first image
 *   - videoPath (string): absolute path to video
 *   - titleText (string): video title
 *   - postId (string): UUID of the post
 *   - platform (string): target platform name
 *   - hashtags (string[]): extracted hashtags
 *   - tags (string[]): post tags
 *   - scheduledAt (string): ISO datetime
 *
 * Variable mapping rules:
 *   1. Explicit mappings in `variableMapping` override auto-detection
 *   2. Workflow variables whose names match post data keys get auto-filled
 *   3. Common aliases: caption → text, content → text, image → imagePath, etc.
 *   4. Additional explicit overrides can be passed
 */
function mapPostToVariables(workflow, postData, explicitOverrides) {
  const variables = {};

  // Common aliases for post data field names
  const ALIASES = {
    caption: 'text',
    captionText: 'text',
    content: 'text',
    postText: 'text',
    post_text: 'text',
    caption_text: 'text',
    image: 'imagePath',
    image_path: 'imagePath',
    imageFile: 'imagePath',
    video: 'videoPath',
    video_path: 'videoPath',
    videoFile: 'videoPath',
    title: 'titleText',
    titleText: 'titleText',
    title_text: 'titleText',
    videoTitle: 'titleText',
    post_id: 'postId',
    postId: 'postId',
  };

  const wfVars = workflow.variables || [];

  for (const varDecl of wfVars) {
    const name = varDecl.name;
    let value = undefined;

    // 1. Check explicit overrides first
    if (explicitOverrides && explicitOverrides[name] !== undefined) {
      value = explicitOverrides[name];
    }
    // 2. Check workflow's own variableMapping metadata
    else if (workflow.metadata?.variableMapping && workflow.metadata.variableMapping[name]) {
      const sourceField = workflow.metadata.variableMapping[name];
      value = postData[sourceField];
    }
    // 3. Direct name match with post data
    else if (postData[name] !== undefined) {
      value = postData[name];
    }
    // 4. Alias match
    else if (ALIASES[name] && postData[ALIASES[name]] !== undefined) {
      value = postData[ALIASES[name]];
    }
    // 5. Use default if available
    else if (varDecl.default !== undefined) {
      value = varDecl.default;
    }

    if (value !== undefined) {
      variables[name] = value;
    }
  }

  return variables;
}

/**
 * Check which workflow variables are satisfied by the given post data.
 * Returns { satisfied: [...], missing: [...], optional: [...] }
 */
function checkVariableCoverage(workflow, postData) {
  const wfVars = workflow.variables || [];
  const mapped = mapPostToVariables(workflow, postData);

  const satisfied = [];
  const missing = [];
  const optional = [];

  for (const varDecl of wfVars) {
    if (mapped[varDecl.name] !== undefined) {
      satisfied.push(varDecl.name);
    } else if (varDecl.required) {
      missing.push(varDecl.name);
    } else {
      optional.push(varDecl.name);
    }
  }

  return { satisfied, missing, optional };
}

// ── Variable Substitution ──────────────────────────────────────

const VARIABLE_PATTERN = /\{\{([^}]+)\}\}/g;

function substituteString(template, variables) {
  const trimmed = template.trim();
  const singleMatch = trimmed.match(/^\{\{([^}]+)\}\}$/);
  if (singleMatch) {
    const value = resolvePath(variables, singleMatch[1].trim());
    if (value !== undefined) return value;
    return template;
  }
  return template.replace(VARIABLE_PATTERN, (_match, varPath) => {
    const value = resolvePath(variables, varPath.trim());
    if (value === undefined) return _match;
    return String(value);
  });
}

function resolvePath(obj, pathStr) {
  const parts = pathStr.replace(/\[(\d+)\]/g, '.$1').split('.');
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function substituteObject(obj, variables) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return substituteString(obj, variables);
  if (Array.isArray(obj)) return obj.map(item => substituteObject(item, variables));
  if (typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substituteObject(value, variables);
    }
    return result;
  }
  return obj;
}

// ── Execution ──────────────────────────────────────────────────

/**
 * Execute a workflow using the bridge server.
 *
 * This is a simplified executor that runs workflows step-by-step,
 * similar to Woodbury's WorkflowExecutor but as a standalone CJS module.
 *
 * For complex scenarios (sub-workflows, conditionals, loops), it delegates
 * to the agent by returning instructions.
 *
 * @param {object} bridgeServer - ctx.bridgeServer
 * @param {object} workflow - WorkflowDocument
 * @param {object} variables - Runtime variables
 * @param {object} [options]
 * @param {Function} [options.log] - Logging function
 * @param {AbortSignal} [options.signal] - Abort signal
 * @param {Function} [options.onProgress] - Progress callback (stepIndex, stepLabel, status)
 * @returns {Promise<{ success: boolean, stepsExecuted: number, variables: object, error?: string }>}
 */
async function executeWorkflow(bridgeServer, workflow, variables, options = {}) {
  const { log = () => {}, signal, onProgress } = options;
  const startTime = Date.now();

  // Truncate debug log at start of each execution
  try { fs.writeFileSync(_CLICK_LOG_PATH, `=== NEW EXECUTION: ${workflow.name || workflow.id} @ ${new Date().toISOString()} ===\n`); } catch {}
  clickLog('osInputAvailable', osInputAvailable);
  clickLog('platform', { platform: process.platform, isMac });
  const vars = { ...variables };

  // Validate required variables
  const wfVars = workflow.variables || [];
  const missing = wfVars.filter(v => v.required && vars[v.name] === undefined).map(v => v.name);
  if (missing.length > 0) {
    return {
      success: false,
      stepsExecuted: 0,
      stepsTotal: workflow.steps.length,
      variables: vars,
      error: `Missing required variables: ${missing.join(', ')}`,
      durationMs: Date.now() - startTime,
    };
  }

  // Merge defaults
  for (const v of wfVars) {
    if (vars[v.name] === undefined && v.default !== undefined) {
      vars[v.name] = v.default;
    }
  }

  let stepsExecuted = 0;
  const stepResults = [];

  for (let i = 0; i < workflow.steps.length; i++) {
    if (signal?.aborted) break;

    const rawStep = workflow.steps[i];
    const step = substituteObject(rawStep, vars);

    if (onProgress) {
      onProgress({ type: 'step_start', index: i, total: workflow.steps.length, step });
    }

    log(`Step ${i + 1}/${workflow.steps.length}: ${step.type} — ${step.label || step.id}`);

    try {
      await executeStep(bridgeServer, step, vars, { log, signal });
      stepsExecuted++;
      stepResults.push({ stepId: step.id, status: 'success' });

      if (onProgress) {
        onProgress({ type: 'step_complete', index: i, step, status: 'success' });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log(`Step ${i + 1} failed: ${errorMsg}`);
      stepResults.push({ stepId: step.id, status: 'failed', error: errorMsg });

      if (onProgress) {
        onProgress({ type: 'step_complete', index: i, step, status: 'failed', error: errorMsg });
      }

      return {
        success: false,
        stepsExecuted,
        stepsTotal: workflow.steps.length,
        variables: vars,
        stepResults,
        error: `Step ${i + 1} (${step.label || step.id}) failed: ${errorMsg}`,
        durationMs: Date.now() - startTime,
      };
    }
  }

  return {
    success: true,
    stepsExecuted,
    stepsTotal: workflow.steps.length,
    variables: vars,
    stepResults,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Execute a single workflow step via the bridge.
 */
async function executeStep(bridge, step, variables, { log, signal }) {
  switch (step.type) {
    case 'navigate':
      await bridge.send('open', { url: step.url });
      if (step.waitMs) await sleep(step.waitMs, signal);
      if (step.waitForSelector) {
        await bridge.send('wait_for_element', {
          selector: step.waitForSelector,
          timeout: step.timeoutMs || 10000,
        });
      }
      break;

    case 'click': {
      const eb = step.target?.expectedBounds;
      const hasPct = eb && typeof eb.pctX === 'number' && typeof eb.pctY === 'number';
      const clickAction = step.clickType === 'hover' ? 'hover'
        : step.clickType === 'double' ? 'double_click'
        : step.clickType === 'right' ? 'right_click' : 'click';

      clickLog('=== CLICK STEP ===', { stepId: step.id, label: step.label, hasPct, pctX: eb?.pctX, pctY: eb?.pctY });

      // Strategy: use recorded percentage position directly.
      // This is the most reliable approach — just click where the user clicked.
      if (hasPct) {
        const vp = await getViewport(bridge);
        const vpX = Math.round((eb.pctX / 100) * vp.w);
        const vpY = Math.round((eb.pctY / 100) * vp.h);

        clickLog('pct click', { pct: { x: eb.pctX, y: eb.pctY }, viewport: vp, vpPos: { vpX, vpY } });

        if (clickAction === 'hover') {
          // Hover = just move mouse, no click verification needed
          await performClick(bridge, vpX, vpY, clickAction, signal);
          clickLog('hover result', { moved: true });
        } else {
          // Build verify options from step config
          const verifyOpts = {
            enabled: !!(step.verifyClick?.enabled),
            maxAttempts: step.verifyClick?.maxAttempts ?? 3,
            verifyDelayMs: step.verifyClick?.verifyDelayMs ?? 400,
            retryDelayMs: step.verifyClick?.retryDelayMs ?? 600,
          };

          const result = await clickWithVerification(bridge, vpX, vpY, clickAction, verifyOpts, signal);
          clickLog('click result', result);
        }
      } else if (step.target?.selector) {
        // Fallback: use bridge-based clicking via selector
        await bridge.send('click_element', { selector: step.target.selector });
      }
      if (step.delayAfterMs) await sleep(step.delayAfterMs, signal);
      break;
    }

    case 'type': {
      const typeEb = step.target?.expectedBounds;
      const typeHasPct = typeEb && typeof typeEb.pctX === 'number' && typeof typeEb.pctY === 'number';

      clickLog('=== TYPE STEP ===', { stepId: step.id, label: step.label, value: step.value?.slice(0, 30) });

      // Click to focus the field first — use percentage position
      if (typeHasPct && osInputAvailable) {
        const vp = await getViewport(bridge);
        const vpX = Math.round((typeEb.pctX / 100) * vp.w);
        const vpY = Math.round((typeEb.pctY / 100) * vp.h);
        const { screenX, screenY } = await viewportToScreen(bridge, vpX, vpY);
        clickLog('type click to focus', { vpPos: { vpX, vpY }, screen: { screenX, screenY } });
        moveMouseTo(screenX, screenY);
        await sleep(50, signal);
        await nativeClick();
        await sleep(100, signal);
      } else if (step.target?.selector) {
        try {
          await bridge.send('click_element', { selector: step.target.selector });
          await sleep(100, signal);
        } catch {}
      }

      // Type the value — try bridge set_value first (most reliable for form fields)
      let typed = false;
      if (step.target?.placeholder || step.target?.selector) {
        try {
          const sel = step.target.placeholder
            ? `[placeholder="${step.target.placeholder.replace(/"/g, '\\"')}"]`
            : step.target.selector;
          if (step.clearFirst) {
            try { await bridge.send('set_value', { selector: sel, value: '' }); } catch {}
          }
          await bridge.send('set_value', { selector: sel, value: step.value });
          typed = true;
        } catch {}
      }

      // Fallback: type via OS keyboard (field should be focused from click above)
      if (!typed) {
        if (osInputAvailable) {
          if (step.clearFirst) {
            try { nativeClear(); await sleep(50, signal); } catch {}
          }
          nativeTypeString(step.value);
        } else {
          if (step.clearFirst) {
            try { await bridge.send('keyboard', { action: 'clear' }); } catch {}
          }
          await bridge.send('keyboard', { action: 'type', text: step.value });
        }
      }
      if (step.delayAfterMs) await sleep(step.delayAfterMs, signal);
      break;
    }

    case 'wait':
      if (step.condition?.type === 'delay') {
        await sleep(step.condition.ms || 1000, signal);
      } else if (step.condition?.type === 'element_visible') {
        await waitForCondition(bridge, step.condition, step.timeoutMs || 30000, signal);
      } else if (step.condition?.type === 'element_hidden') {
        await waitForElementHidden(bridge, step.condition, step.timeoutMs || 30000, signal);
      } else if (step.condition?.type === 'text_appears') {
        await waitForTextCondition(bridge, step.condition, step.timeoutMs || 30000, signal);
      } else if (step.condition?.type === 'text_disappears') {
        await waitForTextCondition(bridge, step.condition, step.timeoutMs || 30000, signal);
      } else if (step.condition?.type === 'url_contains') {
        await waitForUrlCondition(bridge, step.condition, step.timeoutMs || 30000, signal);
      } else if (step.condition?.type === 'network_idle') {
        await sleep(step.condition.timeoutMs || 3000, signal);
      } else {
        await sleep(step.timeoutMs || 2000, signal);
      }
      break;

    case 'assert': {
      const passed = await checkAssertCondition(bridge, step.condition, variables);
      if (!passed) {
        throw new Error(step.errorMessage || `Assertion failed: ${JSON.stringify(step.condition)}`);
      }
      break;
    }

    case 'keyboard':
      if (osInputAvailable) {
        // OS-level keyboard input (real, trusted events)
        const keyModifiers = [];
        if (step.modifiers?.includes('ctrl')) keyModifiers.push(isMac ? 'command' : 'control');
        if (step.modifiers?.includes('shift')) keyModifiers.push('shift');
        if (step.modifiers?.includes('alt')) keyModifiers.push('alt');
        nativeKeyTap(step.key.toLowerCase(), keyModifiers);
      } else {
        if (step.modifiers?.length > 0) {
          await bridge.send('keyboard', {
            action: 'hotkey',
            key: step.key,
            ctrl: step.modifiers.includes('ctrl'),
            shift: step.modifiers.includes('shift'),
            alt: step.modifiers.includes('alt'),
          });
        } else {
          await bridge.send('keyboard', { action: 'press', key: step.key });
        }
      }
      break;

    case 'scroll':
      if (step.target) {
        // Scroll to specific element via bridge (DOM-level, always works)
        await bridge.send('scroll_to_element', { selector: step.target.selector });
      } else if (osInputAvailable) {
        // OS-level scroll (real events)
        const yAmt = step.direction === 'down' ? (step.amount || 3) : -(step.amount || 3);
        nativeScroll(0, yAmt);
      } else {
        const yAmount = step.direction === 'down' ? (step.amount || 3) : -(step.amount || 3);
        await bridge.send('mouse', { action: 'scroll', scrollY: yAmount, scrollX: 0 });
      }
      break;

    case 'download': {
      const dlResolved = await resolveElement(bridge, step.trigger);
      if (dlResolved.position) {
        const cx = Math.round(dlResolved.position.left + dlResolved.position.width / 2);
        const cy = Math.round(dlResolved.position.top + dlResolved.position.height / 2);
        if (osInputAvailable) {
          const { screenX, screenY } = await viewportToScreen(bridge, cx, cy);
          moveMouseTo(screenX, screenY);
          await sleep(50, signal);
          await nativeClick();
        } else {
          await bridge.send('mouse', { action: 'click', x: cx, y: cy });
        }
      } else {
        await bridge.send('click_element', { selector: step.trigger.selector });
      }
      if (step.waitMs) await sleep(step.waitMs, signal);
      break;
    }

    case 'move_file': {
      const fsPromises = require('fs').promises;
      const pathModule = require('path');
      const source = step.source;
      const destination = step.destination;

      // Handle array sources (from capture_download variable)
      if (Array.isArray(source)) {
        if (source.length === 0) throw new Error('No source files to move (empty array)');
        await fsPromises.mkdir(destination, { recursive: true });
        for (const file of source) {
          const destFile = pathModule.join(destination, pathModule.basename(file));
          await fsPromises.rename(file, destFile);
          log(`Moved: ${file} → ${destFile}`);
        }
        break;
      }

      // Handle glob patterns
      if (typeof source === 'string' && source.includes('*')) {
        const dir = pathModule.dirname(source);
        const filePattern = pathModule.basename(source);
        const regex = new RegExp(
          '^' + filePattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
        );
        const entries = await fsPromises.readdir(dir);
        const matches = entries.filter(e => regex.test(e)).map(e => pathModule.join(dir, e));
        if (matches.length === 0) throw new Error(`No files matching pattern: ${source}`);
        await fsPromises.mkdir(destination, { recursive: true });
        for (const file of matches) {
          const destFile = pathModule.join(destination, pathModule.basename(file));
          await fsPromises.rename(file, destFile);
          log(`Moved: ${file} → ${destFile}`);
        }
        break;
      }

      // Single file move
      await fsPromises.mkdir(pathModule.dirname(destination), { recursive: true });
      await fsPromises.rename(source, destination);
      log(`Moved: ${source} → ${destination}`);
      break;
    }

    case 'set_variable': {
      let value;
      switch (step.source.type) {
        case 'literal':
          value = step.source.value;
          break;
        case 'element_text': {
          const resolved = await resolveElement(bridge, step.source.target);
          value = resolved.textContent || '';
          break;
        }
        case 'url': {
          const info = await bridge.send('get_page_info');
          value = info?.url || '';
          break;
        }
        default:
          value = '';
      }
      variables[step.variable] = value;
      break;
    }

    case 'sub_workflow': {
      // Load and execute sub-workflow
      const subPath = step.workflowPath;
      if (!fs.existsSync(subPath)) {
        throw new Error(`Sub-workflow not found: ${subPath}`);
      }
      const subWf = JSON.parse(fs.readFileSync(subPath, 'utf-8'));
      const subVars = { ...variables };
      if (step.variables) {
        Object.assign(subVars, step.variables);
      }
      const subResult = await executeWorkflow(bridge, subWf, subVars, { log, signal });
      // Propagate variable changes back
      Object.assign(variables, subResult.variables);
      if (!subResult.success) {
        throw new Error(`Sub-workflow "${subWf.name}" failed: ${subResult.error}`);
      }
      break;
    }

    case 'conditional': {
      const condPassed = await checkAssertCondition(bridge, step.condition, variables);
      const stepsToRun = condPassed ? step.thenSteps : (step.elseSteps || []);
      for (const subStep of stepsToRun) {
        const substituted = substituteObject(subStep, variables);
        await executeStep(bridge, substituted, variables, { log, signal });
      }
      break;
    }

    case 'loop': {
      const items = variables[step.overVariable];
      if (!Array.isArray(items)) {
        throw new Error(`Loop variable "${step.overVariable}" is not an array`);
      }
      for (let idx = 0; idx < items.length; idx++) {
        if (signal?.aborted) break;
        variables[step.itemVariable] = items[idx];
        if (step.indexVariable) variables[step.indexVariable] = idx;
        for (const loopStep of step.steps) {
          const substituted = substituteObject(loopStep, variables);
          await executeStep(bridge, substituted, variables, { log, signal });
        }
      }
      break;
    }

    case 'try_catch': {
      try {
        for (const tryStep of step.trySteps) {
          const substituted = substituteObject(tryStep, variables);
          await executeStep(bridge, substituted, variables, { log, signal });
        }
      } catch (err) {
        if (step.errorVariable) {
          variables[step.errorVariable] = err instanceof Error ? err.message : String(err);
        }
        for (const catchStep of step.catchSteps) {
          const substituted = substituteObject(catchStep, variables);
          await executeStep(bridge, substituted, variables, { log, signal });
        }
      }
      break;
    }

    case 'capture_download': {
      const maxFiles = step.maxFiles ?? 1;
      const lookbackMs = step.lookbackMs ?? 30000;
      const waitTimeoutMs = step.waitTimeoutMs ?? 60000;
      const outputVariable = step.outputVariable ?? 'downloadedFiles';

      log(`capture_download: pattern=${step.filenamePattern || '*'}, max=${maxFiles}, lookback=${lookbackMs}ms`);

      // Query recent downloads from Chrome via bridge
      const queryResult = await bridge.send('get_downloads', {
        limit: maxFiles * 3,
        filenamePattern: step.filenamePattern,
        sinceMs: lookbackMs,
      });

      const downloads = queryResult?.downloads ?? [];
      if (downloads.length === 0) {
        throw new Error('No matching downloads found');
      }

      // Wait for in-progress downloads to complete
      const inProgressIds = downloads.filter(d => d.state === 'in_progress').map(d => d.id);
      if (inProgressIds.length > 0) {
        log(`Waiting for ${inProgressIds.length} in-progress download(s)...`);
        await bridge.send('wait_downloads_complete', {
          downloadIds: inProgressIds,
          timeoutMs: waitTimeoutMs,
        });
      }

      // Re-query for completed filenames (may change during download)
      const finalResult = await bridge.send('get_downloads', {
        limit: maxFiles * 3,
        filenamePattern: step.filenamePattern,
        sinceMs: lookbackMs,
        state: 'complete',
      });

      const completedFiles = (finalResult?.downloads ?? [])
        .map(d => d.filename)
        .slice(0, maxFiles);

      if (completedFiles.length === 0) {
        throw new Error('No completed downloads found after waiting');
      }

      // Store file paths in workflow variables
      variables[outputVariable] = completedFiles;
      log(`Captured ${completedFiles.length} file(s): ${completedFiles.join(', ')}`);
      break;
    }

    case 'file_dialog': {
      const filePath = step.filePath;
      const outputVariable = step.outputVariable ?? 'selectedFile';
      const delayBeforeMs = step.delayBeforeMs ?? 2000;
      const delayAfterMs = step.delayAfterMs ?? 1000;

      log(`file_dialog: path=${filePath}, trigger=${!!step.trigger}`);

      // Validate absolute path
      if (!filePath || (!filePath.startsWith('/') && !filePath.match(/^[A-Z]:\\/))) {
        throw new Error(`file_dialog: filePath must be absolute. Got: "${filePath}"`);
      }

      // Click trigger element to open the file dialog (if specified)
      if (step.trigger && step.trigger.selector) {
        const triggerEb = step.trigger.expectedBounds;
        const triggerHasPct = triggerEb && typeof triggerEb.pctX === 'number' && typeof triggerEb.pctY === 'number';
        if (triggerHasPct) {
          const vp = await getViewport(bridge);
          const vpX = Math.round((triggerEb.pctX / 100) * vp.w);
          const vpY = Math.round((triggerEb.pctY / 100) * vp.h);
          await bridge.send('mouse', { action: 'click', x: vpX, y: vpY });
        } else {
          await bridge.send('click_element', { selector: step.trigger.selector });
        }
      }

      // Wait for OS dialog to appear
      await sleep(delayBeforeMs, signal);

      // Navigate the OS file dialog using flow-frame-core
      // Use require() with createRequire to resolve from the main Woodbury project
      let flowFrameOps;
      try {
        const { createRequire } = await import('node:module');
        const woodburyDir = require('path').join(require('os').homedir(), 'Documents', 'GitHub', 'woodbury');
        const woodburyRequire = createRequire(require('path').join(woodburyDir, 'package.json'));
        flowFrameOps = woodburyRequire('flow-frame-core/dist/operations.js');
      } catch (err) {
        throw new Error(`file_dialog: Failed to load flow-frame-core: ${err.message}`);
      }

      try {
        await flowFrameOps.fileModalOperate(filePath);
      } catch (err) {
        throw new Error(`file_dialog: Dialog operation failed: ${err.message}`);
      }

      // Wait for page to process the selected file
      if (delayAfterMs > 0) await sleep(delayAfterMs, signal);

      // Store the file path in workflow variables
      variables[outputVariable] = filePath;
      log(`file_dialog complete: stored ${filePath} in ${outputVariable}`);
      break;
    }

    case 'desktop_launch_app': {
      const appName = substituteString(step.appName, variables);
      log(`desktop_launch_app: ${appName}`);
      const { execSync: execSyncLocal } = require('child_process');
      if (process.platform === 'darwin') {
        try {
          execSyncLocal(`osascript -e 'tell application "${appName.replace(/"/g, '\\"')}" to activate'`, { timeout: 5000 });
        } catch {
          execSyncLocal(`open -a "${appName.replace(/"/g, '\\"')}"`, { timeout: 5000 });
        }
      } else if (process.platform === 'win32') {
        try {
          execSyncLocal(`powershell -NoProfile -c "Start-Process '${appName.replace(/'/g, "''")}';"`, { timeout: 5000 });
        } catch {
          require('child_process').spawn('cmd', ['/c', 'start', '', appName], { detached: true, stdio: 'ignore' });
        }
      } else {
        require('child_process').spawn(appName.toLowerCase(), [], { detached: true, stdio: 'ignore' });
      }
      await sleep(step.delayAfterMs || 2000, signal);
      break;
    }

    case 'desktop_click': {
      log(`desktop_click: (${step.x}, ${step.y}) action=${step.action} app=${step.app || 'any'}`);
      if (!robot) {
        throw new Error('desktop_click requires robotjs (OS-level input not available)');
      }
      // Move mouse to absolute screen coordinates (no Chrome offset)
      if (isWindows) {
        robot.moveMouse(step.x, step.y);
      } else {
        robot.moveMouseSmooth(step.x, step.y);
      }
      await sleep(100, signal);
      // Perform click
      if (step.action === 'double_click') {
        robot.mouseClick('left', true);
      } else if (step.action === 'right_click') {
        robot.mouseClick('right');
      } else {
        robot.mouseClick();
      }
      await sleep(step.delayAfterMs || 500, signal);
      break;
    }

    case 'desktop_type': {
      log(`desktop_type: "${(step.value || '').slice(0, 50)}"`);
      if (!robot) {
        throw new Error('desktop_type requires robotjs');
      }
      const text = substituteString(step.value || '', variables);
      robot.typeString(text);
      await sleep(step.delayAfterMs || 300, signal);
      break;
    }

    case 'desktop_keyboard': {
      const mods = step.modifiers ? step.modifiers.join('+') + '+' : '';
      log(`desktop_keyboard: ${mods}${step.key}`);
      if (!robot) {
        throw new Error('desktop_keyboard requires robotjs');
      }
      // Map modifier names to robotjs modifier names
      const robotMods = (step.modifiers || []).map(m => {
        if (m === 'cmd') return process.platform === 'darwin' ? 'command' : 'control';
        if (m === 'ctrl') return 'control';
        return m;
      });
      robot.keyTap(step.key, robotMods);
      await sleep(step.delayAfterMs || 300, signal);
      break;
    }

    default:
      log(`Unknown step type: ${step.type} — skipping`);
  }
}

// ── Element Resolution ─────────────────────────────────────────

/**
 * Normalize a single element from a bridge find response.
 */
function normalizeElement(el) {
  if (!el) return null;
  return {
    position: el.position || el.bounds || null,
    textContent: el.textContent || el.text || null,
    attributes: el.attributes || {},
    tagName: el.tagName || el.tag || null,
    context: el.context || null,
  };
}

/**
 * Extract a normalized result from a bridge find response.
 * If the target has context and there are multiple matches, use context
 * scoring to pick the best one rather than blindly taking the first.
 */
function extractElement(result, targetContext) {
  if (!result) return null;
  const arr = Array.isArray(result) ? result : result.results;
  if (!arr || arr.length === 0) return null;

  // Single result or no context to disambiguate — take the first
  if (arr.length === 1 || !targetContext) {
    return normalizeElement(arr[0]);
  }

  // Multiple results with context — score each candidate
  return pickBestMatch(arr, targetContext);
}

/**
 * Extract ALL normalized results from a bridge find response.
 */
function extractAllElements(result) {
  if (!result) return [];
  const arr = Array.isArray(result) ? result : result.results;
  if (!arr || arr.length === 0) return [];
  return arr.map(normalizeElement).filter(Boolean);
}

/**
 * Score how well a candidate element matches the stored context.
 * Higher score = better match. Used when multiple elements share
 * the same text (e.g., 2 "Create" buttons).
 *
 * Scoring signals:
 *   +10  Landmark matches (same section/region)
 *   +8   Nearest heading matches
 *   +6   Ancestor chain similarity (at least 2 of first 3 match)
 *   +4   Nth-of-type index matches
 *   +3   Sibling text matches (at least 1 sibling has matching text)
 *   +2   Associated label matches
 */
function scoreElementContext(candidate, targetContext) {
  if (!targetContext || !candidate.context) return 0;
  const cc = candidate.context;
  let score = 0;

  // Landmark match (e.g., both in <main>, both in <nav>, both in <dialog>)
  if (targetContext.landmark && cc.landmark) {
    if (targetContext.landmark.tag === cc.landmark.tag) {
      score += 5;
      if (targetContext.landmark.id && targetContext.landmark.id === cc.landmark.id) {
        score += 5; // exact landmark match
      } else if (targetContext.landmark.ariaLabel && targetContext.landmark.ariaLabel === cc.landmark.ariaLabel) {
        score += 3;
      } else if (targetContext.landmark.role && targetContext.landmark.role === cc.landmark.role) {
        score += 2;
      }
    }
  }

  // Nearest heading match (e.g., both under "Song Settings" vs "Explore")
  if (targetContext.nearestHeading && cc.nearestHeading) {
    const targetText = targetContext.nearestHeading.text?.toLowerCase() || '';
    const candText = cc.nearestHeading.text?.toLowerCase() || '';
    if (targetText && candText) {
      if (targetText === candText) {
        score += 8; // exact heading match
      } else if (candText.includes(targetText) || targetText.includes(candText)) {
        score += 4; // partial heading match
      }
    }
  }

  // Ancestor chain similarity
  if (targetContext.ancestors?.length && cc.ancestors?.length) {
    let ancestorMatches = 0;
    const compareLen = Math.min(3, targetContext.ancestors.length, cc.ancestors.length);
    for (let i = 0; i < compareLen; i++) {
      // Compare just the tag+id part (before any aria-label)
      const tAncestor = (targetContext.ancestors[i] || '').split('"')[0].trim();
      const cAncestor = (cc.ancestors[i] || '').split('"')[0].trim();
      if (tAncestor && cAncestor && tAncestor === cAncestor) {
        ancestorMatches++;
      }
    }
    if (ancestorMatches >= 2) {
      score += 6;
    } else if (ancestorMatches === 1) {
      score += 2;
    }
  }

  // Nth-of-type index (e.g., "2nd of 2 Create buttons")
  if (targetContext.nthWithSameText && cc.nthWithSameText) {
    if (targetContext.nthWithSameText === cc.nthWithSameText) {
      score += 4;
    }
  }

  // Sibling text match
  if (targetContext.siblings?.length && cc.siblings?.length) {
    for (const tSib of targetContext.siblings) {
      for (const cSib of cc.siblings) {
        if (tSib.text && cSib.text &&
            tSib.position === cSib.position &&
            tSib.text.toLowerCase() === cSib.text.toLowerCase()) {
          score += 3;
          break;
        }
      }
    }
  }

  // Label match
  if (targetContext.label && cc.label) {
    if (targetContext.label.toLowerCase() === cc.label.toLowerCase()) {
      score += 2;
    }
  }

  return score;
}

/**
 * From a list of candidate elements, pick the one that best matches
 * the target's stored context. Falls back to the first element if
 * no context differentiation is possible.
 */
function pickBestMatch(candidates, targetContext) {
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1 || !targetContext) {
    return normalizeElement(candidates[0]);
  }

  let bestEl = null;
  let bestScore = -1;

  for (const cand of candidates) {
    const normalized = normalizeElement(cand);
    if (!normalized) continue;
    const score = scoreElementContext(normalized, targetContext);
    if (score > bestScore) {
      bestScore = score;
      bestEl = normalized;
    }
  }

  // If no candidate scored above 0, fall back to first
  if (bestScore <= 0) {
    return normalizeElement(candidates[0]);
  }

  return bestEl;
}

/**
 * Pick the element closest to the expected viewport position.
 * Returns the best candidate (or first if no positions available).
 */
function pickClosestToPosition(candidates, expectedX, expectedY) {
  const { picked } = pickClosestToPositionWithDist(candidates, expectedX, expectedY);
  return picked;
}

/**
 * Pick the element closest to the expected viewport position.
 * Returns both the best candidate and the distance.
 */
function pickClosestToPositionWithDist(candidates, expectedX, expectedY) {
  let best = null;
  let bestDist = Infinity;

  for (const el of candidates) {
    if (!el || !el.position) continue;
    const cx = el.position.left + (el.position.width || 0) / 2;
    const cy = el.position.top + (el.position.height || 0) / 2;
    const dist = Math.sqrt(
      Math.pow(cx - expectedX, 2) + Math.pow(cy - expectedY, 2)
    );
    if (dist < bestDist) {
      bestDist = dist;
      best = el;
    }
  }

  return { picked: best || (candidates.length > 0 ? candidates[0] : null), dist: bestDist };
}

/**
 * Grid-based sector tracking.
 * Divides the viewport into an 8x8 grid and computes which sector a point falls in.
 * Used to quickly filter candidates: elements in a different sector are unlikely to be correct.
 */
const GRID_SIZE = 8;

function getGridSector(x, y, vpW, vpH) {
  const col = Math.min(GRID_SIZE - 1, Math.max(0, Math.floor((x / vpW) * GRID_SIZE)));
  const row = Math.min(GRID_SIZE - 1, Math.max(0, Math.floor((y / vpH) * GRID_SIZE)));
  return { col, row };
}

function sameGridSector(sector1, sector2) {
  // Allow ±1 sector tolerance (adjacent sectors are OK)
  return Math.abs(sector1.col - sector2.col) <= 1 && Math.abs(sector1.row - sector2.row) <= 1;
}

/**
 * Filter candidates to only those in the same grid sector (±1) as the expected position.
 * Returns filtered list, or the original list if filtering removes everything.
 */
function filterByGridSector(candidates, expectedX, expectedY, vpW, vpH) {
  if (!vpW || !vpH) return candidates;
  const expectedSector = getGridSector(expectedX, expectedY, vpW, vpH);
  const filtered = candidates.filter(el => {
    if (!el || !el.position) return false;
    const cx = el.position.left + (el.position.width || 0) / 2;
    const cy = el.position.top + (el.position.height || 0) / 2;
    const sector = getGridSector(cx, cy, vpW, vpH);
    return sameGridSector(expectedSector, sector);
  });
  // Don't filter down to nothing — return original if all were rejected
  return filtered.length > 0 ? filtered : candidates;
}

/**
 * Check if a found element's position is plausible given expectedBounds.
 * Allows for drift within the tolerance window. Returns true if no
 * expectedBounds are specified (anything goes).
 */
function boundsPlausible(position, expectedBounds) {
  if (!expectedBounds || !position) return true;
  const tolerance = expectedBounds.tolerance || 80;
  const dx = Math.abs((position.left || 0) - (expectedBounds.left || 0));
  const dy = Math.abs((position.top || 0) - (expectedBounds.top || 0));
  return dx <= tolerance * 3 && dy <= tolerance * 3; // generous — 3× tolerance for layout shifts
}

/**
 * Build a rich debug string for element-not-found errors.
 */
function describeTarget(target) {
  const parts = [];
  if (target.selector) parts.push(`selector="${target.selector}"`);
  if (target.textContent) parts.push(`text="${target.textContent}"`);
  if (target.description) parts.push(`desc="${target.description}"`);
  if (target.placeholder) parts.push(`placeholder="${target.placeholder}"`);
  if (target.ariaLabel) parts.push(`aria-label="${target.ariaLabel}"`);
  if (target.context?.nearestHeading) parts.push(`heading="${target.context.nearestHeading.text}"`);
  if (target.context?.nthWithSameText) parts.push(`nth=${target.context.nthWithSameText}/${target.context.totalWithSameText}`);
  return parts.join(', ') || 'unknown';
}

/**
 * Get the current viewport dimensions from the bridge.
 * Cached briefly since we call it often during resolution.
 */
let cachedViewport = null;
let lastViewportFetch = 0;
async function getViewport(bridge) {
  const now = Date.now();
  if (cachedViewport && (now - lastViewportFetch) < 5000) return cachedViewport;
  try {
    const info = await bridge.send('get_page_info');
    if (info?.viewport) {
      cachedViewport = { w: info.viewport.width, h: info.viewport.height };
    } else {
      // Fallback: use common defaults
      cachedViewport = { w: info?.viewportWidth || 1440, h: info?.viewportHeight || 900 };
    }
    lastViewportFetch = now;
  } catch {
    cachedViewport = cachedViewport || { w: 1440, h: 900 };
  }
  return cachedViewport;
}

/**
 * Fuzzy text match — case-insensitive, trims whitespace, allows partial match.
 * Returns a score: 1.0 = exact, 0.5+ = partial, 0 = no match.
 */
function fuzzyTextScore(needle, haystack) {
  if (!needle || !haystack) return 0;
  const a = needle.toLowerCase().trim();
  const b = haystack.toLowerCase().trim();
  if (a === b) return 1.0;
  if (b.includes(a)) return 0.7;
  if (a.includes(b)) return 0.5;
  // Check if most words match
  const aWords = a.split(/\s+/);
  const bWords = b.split(/\s+/);
  let matches = 0;
  for (const w of aWords) {
    if (bWords.some(bw => bw.includes(w) || w.includes(bw))) matches++;
  }
  return aWords.length > 0 ? (matches / aWords.length) * 0.6 : 0;
}

/**
 * Resolve a target element using a multi-strategy approach.
 *
 * Strategy hierarchy (most specific → least specific):
 *
 *   Phase 1: PLACEHOLDER
 *     Form fields identified by placeholder text — uniquely identifies inputs.
 *
 *   Phase 2: STABLE IDENTIFIERS
 *     data-testid, name attribute — rarely change, exact matches.
 *
 *   Phase 3: CSS SELECTOR + PROXIMITY VALIDATION
 *     Try the recorded selector. If multiple matches, pick by proximity.
 *     Validate that the result is near the expected position.
 *
 *   Phase 4: ANCESTOR-ENRICHED TEXT
 *     If the target's context includes descriptive ancestor text (e.g.,
 *     button "Create song"), use that for a more specific text search.
 *
 *   Phase 5: TEXT + STRICT PROXIMITY
 *     Find elements matching text, pick closest to expected position.
 *     Reject if the best match is too far from expected (prevents
 *     picking a same-text element in the wrong part of the page).
 *
 *   Phase 6: DOM FALLBACK
 *     Fallback selectors, aria-label, find_interactive.
 *
 *   Phase 7: TEXT + LOOSE PROXIMITY
 *     Same as Phase 5 but without the strict distance threshold.
 *
 *   Phase 8: RAW PERCENTAGE CLICK
 *     If everything else fails, click at the recorded percentage position.
 */
async function resolveElement(bridge, target) {
  const eb = target.expectedBounds;
  const ctx = target.context || null;
  const hasPct = eb && typeof eb.pctX === 'number' && typeof eb.pctY === 'number';
  const tolerance = eb?.tolerance || 80;

  // Compute expected viewport position once (used by multiple phases)
  let expectedX, expectedY;
  if (hasPct) {
    try {
      const vp = await getViewport(bridge);
      expectedX = (eb.pctX / 100) * vp.w;
      expectedY = (eb.pctY / 100) * vp.h;
    } catch {}
  } else if (eb) {
    expectedX = eb.left + (eb.width || 0) / 2;
    expectedY = eb.top + (eb.height || 0) / 2;
  }

  clickLog('resolveElement', {
    textContent: target.textContent?.slice(0, 30),
    selector: target.selector?.slice(0, 50),
    placeholder: target.placeholder?.slice(0, 30),
    hasPct,
    expectedPos: expectedX !== undefined ? { x: Math.round(expectedX), y: Math.round(expectedY) } : null,
    ancestors: ctx?.ancestors?.slice(0, 2),
    nthWithSameText: ctx?.nthWithSameText,
  });

  // ── Phase 1: Placeholder ──
  // Uniquely identifies form fields (inputs, textareas).
  if (target.placeholder) {
    try {
      const escaped = target.placeholder.replace(/"/g, '\\"');
      const result = await bridge.send('find_elements', {
        selector: `[placeholder="${escaped}"], [placeholder*="${escaped.slice(0, 30)}"]`,
        limit: 5,
      });
      const el = extractElement(result, ctx);
      if (el && el.position) {
        clickLog('resolved by placeholder', { placeholder: target.placeholder.slice(0, 30), position: el.position });
        return { ...el, matchedBy: 'placeholder' };
      }
    } catch {}
  }

  // ── Phase 2: Stable identifiers ──
  if (target.dataTestId) {
    try {
      const result = await bridge.send('find_elements', {
        selector: `[data-testid="${target.dataTestId}"], [data-test-id="${target.dataTestId}"]`,
        limit: 1,
      });
      const el = extractElement(result);
      if (el && el.position) {
        clickLog('resolved by dataTestId', { id: target.dataTestId });
        return { ...el, matchedBy: 'dataTestId' };
      }
    } catch {}
  }
  if (target.name) {
    try {
      const result = await bridge.send('find_elements', {
        selector: `[name="${target.name}"]`,
        limit: 1,
      });
      const el = extractElement(result);
      if (el && el.position) {
        clickLog('resolved by name', { name: target.name });
        return { ...el, matchedBy: 'nameAttr' };
      }
    } catch {}
  }

  // ── Phase 3: CSS selector + proximity disambiguation ──
  // The recorded CSS selector is specific to the exact element. Try it early.
  // If multiple elements match, use proximity to pick the right one.
  if (target.selector) {
    try {
      const result = await bridge.send('find_elements', { selector: target.selector, limit: 10 });
      const arr = extractAllElements(result);
      clickLog('phase 3 selector', { selector: target.selector.slice(0, 50), matchCount: arr.length });

      if (arr.length === 1 && arr[0].position) {
        clickLog('resolved by selector (unique)', { position: arr[0].position });
        return { ...arr[0], matchedBy: 'selector' };
      }
      if (arr.length > 1 && expectedX !== undefined) {
        // Multiple matches — pick closest to expected position
        const picked = pickClosestToPosition(arr, expectedX, expectedY);
        if (picked && picked.position) {
          clickLog('resolved by selector+proximity', { position: picked.position });
          return { ...picked, matchedBy: 'selector+proximity' };
        }
      }
      // Single match even without position validation
      if (arr.length >= 1 && arr[0].position) {
        if (boundsPlausible(arr[0].position, eb)) {
          clickLog('resolved by selector (bounds ok)', { position: arr[0].position });
          return { ...arr[0], matchedBy: 'selector' };
        }
      }
    } catch {}
  }

  // ── Phase 4: Ancestor-enriched text ──
  // If the context includes descriptive ancestor text (e.g., button "Create song"),
  // search for that more specific text first. This prevents picking a same-name
  // element in a different part of the page.
  if (ctx?.ancestors?.length) {
    for (const ancestor of ctx.ancestors) {
      // Look for ancestors with quoted text like: button "Create song"
      const textMatch = ancestor.match(/"([^"]+)"/);
      if (textMatch && textMatch[1] && textMatch[1] !== target.textContent) {
        const ancestorText = textMatch[1];
        try {
          const result = await bridge.send('find_element_by_text', {
            text: ancestorText,
            limit: 10,
          });
          const arr = extractAllElements(result);
          clickLog('phase 4 ancestor text', { ancestorText, matchCount: arr.length });

          if (arr.length === 1 && arr[0].position) {
            clickLog('resolved by ancestor text (unique)', { text: ancestorText, position: arr[0].position });
            return { ...arr[0], matchedBy: 'ancestorText' };
          }
          if (arr.length > 1 && expectedX !== undefined) {
            const picked = pickClosestToPosition(arr, expectedX, expectedY);
            if (picked && picked.position) {
              clickLog('resolved by ancestor text+proximity', { text: ancestorText, position: picked.position });
              return { ...picked, matchedBy: 'ancestorText+proximity' };
            }
          }
          if (arr.length >= 1 && arr[0].position && boundsPlausible(arr[0].position, eb)) {
            clickLog('resolved by ancestor text (bounds ok)', { text: ancestorText, position: arr[0].position });
            return { ...arr[0], matchedBy: 'ancestorText' };
          }
        } catch {}
      }
    }
  }

  // ── Phase 5: Text + strict proximity ──
  // Find all elements with matching text, pick the closest to expected position.
  // STRICT: reject if best match is more than 300px from expected (prevents
  // picking a same-text element in the wrong part of the page).
  const STRICT_MAX_DIST = 300;
  let textLooseCandidate = null; // saved for Phase 7

  if (target.textContent) {
    try {
      const result = await bridge.send('find_element_by_text', {
        text: target.textContent,
        limit: 20,
      });
      const arr = extractAllElements(result);
      clickLog('phase 5 text search', { text: target.textContent, matchCount: arr.length });

      if (arr.length === 1 && arr[0].position) {
        // Unique text match — always accept
        clickLog('resolved by text (unique)', { position: arr[0].position });
        return { ...arr[0], matchedBy: 'text(unique)' };
      }

      if (arr.length > 1 && expectedX !== undefined) {
        // Filter by grid sector first — reject elements in completely different parts of the page
        const vp = await getViewport(bridge);
        const sectorFiltered = filterByGridSector(arr, expectedX, expectedY, vp.w, vp.h);
        clickLog('phase 5 grid filter', {
          before: arr.length,
          after: sectorFiltered.length,
          expectedSector: getGridSector(expectedX, expectedY, vp.w, vp.h),
        });

        const { picked, dist } = pickClosestToPositionWithDist(sectorFiltered, expectedX, expectedY);
        clickLog('phase 5 best candidate', { dist: Math.round(dist), threshold: STRICT_MAX_DIST, position: picked?.position });

        if (picked && picked.position && dist <= STRICT_MAX_DIST) {
          clickLog('resolved by text+proximity (strict)', { dist: Math.round(dist), position: picked.position });
          return { ...picked, matchedBy: 'text+proximity' };
        }
        // Save for loose matching in Phase 7
        if (picked && picked.position) {
          textLooseCandidate = { ...picked, matchedBy: 'text+proximity(loose)' };
        }
      } else if (arr.length > 1) {
        // Multiple matches, no position data — use context scoring
        const el = extractElement(result, ctx);
        if (el && el.position) {
          clickLog('resolved by text+context', { position: el.position });
          return { ...el, matchedBy: 'text+context' };
        }
      }
    } catch {}
  }

  // ── Phase 6: DOM fallback strategies ──
  // Fallback selectors, aria-label, find_interactive
  const domStrategies = [];

  if (target.fallbackSelectors) {
    for (const sel of target.fallbackSelectors) {
      domStrategies.push({ name: `fallback(${sel.slice(0, 30)})`, fn: async () => {
        const result = await bridge.send('find_elements', { selector: sel, limit: 5 });
        return extractElement(result, ctx);
      }});
    }
  }
  if (target.ariaLabel) {
    domStrategies.push({ name: 'ariaLabel', fn: async () => {
      const result = await bridge.send('find_elements', {
        selector: `[aria-label="${target.ariaLabel}"], [aria-label*="${target.ariaLabel}"]`,
        limit: 5,
      });
      return extractElement(result, ctx);
    }});
  }

  // find_interactive with contextual hints
  const nlDesc = target.description || target.textContent || target.ariaLabel || target.placeholder || target.title;
  if (nlDesc) {
    let enrichedDesc = nlDesc;
    if (ctx?.nearestHeading?.text) {
      enrichedDesc = `${nlDesc} near "${ctx.nearestHeading.text}"`;
    }
    domStrategies.push({ name: 'find_interactive', fn: async () => {
      const result = await bridge.send('find_interactive', { description: enrichedDesc, limit: 5 });
      return extractElement(result, ctx);
    }});
  }

  let looseFallback = null;
  for (const strategy of domStrategies) {
    try {
      const el = await strategy.fn();
      if (el && el.position) {
        if (boundsPlausible(el.position, eb)) {
          clickLog('resolved by ' + strategy.name, { position: el.position });
          return { ...el, matchedBy: strategy.name };
        }
        if (!looseFallback) {
          looseFallback = { ...el, matchedBy: `${strategy.name}(loose)` };
        }
      }
    } catch {}
  }

  // ── Phase 7: Text + loose proximity ──
  // Accept the closest text match even if far from expected (better than nothing).
  if (textLooseCandidate) {
    clickLog('resolved by text+proximity (loose fallback)', { position: textLooseCandidate.position });
    return textLooseCandidate;
  }

  // ── Phase 8: Raw percentage click ──
  if (hasPct) {
    try {
      const vp = await getViewport(bridge);
      const targetX = (eb.pctX / 100) * vp.w;
      const targetY = (eb.pctY / 100) * vp.h;
      const targetW = eb.pctW ? (eb.pctW / 100) * vp.w : 40;
      const targetH = eb.pctH ? (eb.pctH / 100) * vp.h : 20;
      clickLog('resolved by raw percentage', { pctX: eb.pctX, pctY: eb.pctY });
      return {
        position: {
          left: Math.round(targetX - targetW / 2),
          top: Math.round(targetY - targetH / 2),
          width: Math.round(targetW),
          height: Math.round(targetH),
        },
        textContent: target.textContent || null,
        attributes: {},
        tagName: null,
        context: null,
        matchedBy: 'pct(raw)',
      };
    } catch {}
  }

  // Use loose fallback if we have one
  if (looseFallback) {
    clickLog('resolved by loose DOM fallback', { matchedBy: looseFallback.matchedBy });
    return looseFallback;
  }

  throw new Error(`Element not found: ${describeTarget(target)}`);
}

// ── Wait Conditions ────────────────────────────────────────────

async function waitForCondition(bridge, condition, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    try {
      const resolved = await resolveElement(bridge, condition.target);
      if (resolved.position) return true;
    } catch {}
    await sleep(500, signal);
  }
  throw new Error(`Wait condition not met within ${timeoutMs}ms: element_visible ${condition.target.selector}`);
}

async function waitForElementHidden(bridge, condition, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    try {
      const resolved = await resolveElement(bridge, condition.target);
      // Element found but not visible → it's hidden, wait is satisfied
      if (!resolved.position) return true;
    } catch {
      // Element not found in DOM at all → spinner was removed, wait is satisfied
      return true;
    }
    await sleep(500, signal);
  }
  throw new Error(`Wait condition not met within ${timeoutMs}ms: element_hidden ${condition.target?.selector || '(unknown)'}`);
}

async function waitForTextCondition(bridge, condition, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    try {
      const pageText = await bridge.send('get_page_text');
      const contains = typeof pageText === 'string' && pageText.includes(condition.text);
      if (condition.type === 'text_appears' && contains) return true;
      if (condition.type === 'text_disappears' && !contains) return true;
    } catch {}
    await sleep(500, signal);
  }
  throw new Error(`Wait condition not met within ${timeoutMs}ms: ${condition.type} "${condition.text}"`);
}

async function waitForUrlCondition(bridge, condition, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    try {
      const info = await bridge.send('get_page_info');
      const url = info?.url || '';
      if (condition.type === 'url_contains' && url.includes(condition.substring)) return true;
      if (condition.type === 'url_matches' && new RegExp(condition.pattern).test(url)) return true;
    } catch {}
    await sleep(500, signal);
  }
  throw new Error(`Wait condition not met within ${timeoutMs}ms: ${condition.type}`);
}

async function checkAssertCondition(bridge, condition, variables) {
  switch (condition.type) {
    case 'element_exists':
    case 'element_visible':
      try {
        const resolved = await resolveElement(bridge, condition.target);
        return condition.type === 'element_visible' ? !!resolved.position : true;
      } catch {
        return false;
      }

    case 'element_text_matches':
      try {
        const resolved = await resolveElement(bridge, condition.target);
        if (!resolved.textContent) return false;
        try {
          return new RegExp(condition.pattern).test(resolved.textContent);
        } catch {
          return resolved.textContent.includes(condition.pattern);
        }
      } catch {
        return false;
      }

    case 'url_matches':
      try {
        const info = await bridge.send('get_page_info');
        return new RegExp(condition.pattern).test(info?.url || '');
      } catch {
        return false;
      }

    case 'url_contains':
      try {
        const info = await bridge.send('get_page_info');
        return (info?.url || '').includes(condition.substring);
      } catch {
        return false;
      }

    case 'variable_equals':
      return variables?.[condition.variable] === condition.value;

    default:
      return true;
  }
}

// ── Pipeline (Workflow Chaining) ───────────────────────────────

/**
 * Execute a pipeline of workflows in sequence.
 * Each workflow's output variables are passed as input to the next.
 *
 * @param {object} bridgeServer
 * @param {object[]} workflows - Array of { workflow, variables? }
 * @param {object} initialVariables - Starting variables (e.g., post data)
 * @param {object} [options]
 * @returns {Promise<{ success: boolean, results: object[], finalVariables: object }>}
 */
async function executePipeline(bridgeServer, workflows, initialVariables, options = {}) {
  const { log = () => {} } = options;
  let currentVars = { ...initialVariables };
  const results = [];

  for (let i = 0; i < workflows.length; i++) {
    const { workflow, variables: overrides } = workflows[i];
    const mergedVars = { ...currentVars, ...(overrides || {}) };

    log(`Pipeline ${i + 1}/${workflows.length}: ${workflow.name}`);

    const result = await executeWorkflow(bridgeServer, workflow, mergedVars, options);
    results.push(result);

    if (!result.success) {
      return {
        success: false,
        results,
        finalVariables: currentVars,
        error: `Pipeline step ${i + 1} (${workflow.name}) failed: ${result.error}`,
      };
    }

    // Propagate output variables to next workflow
    currentVars = { ...currentVars, ...result.variables };
  }

  return {
    success: true,
    results,
    finalVariables: currentVars,
  };
}

// ── Utilities ──────────────────────────────────────────────────

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    }
  });
}

/**
 * Execute a single workflow step with coordinate diagnostics.
 * Used by the debug mode to step through workflows one step at a time.
 *
 * Returns { success, error?, coordinateInfo } where coordinateInfo
 * contains the position data used for the step (for debugging).
 */
async function executeSingleStep(bridge, step, variables, options = {}) {
  const { log = () => {}, signal } = options;

  // Substitute variables into the step
  const substituted = substituteObject(step, variables);

  // Get coordinate info BEFORE execution (for diagnostics)
  let coordinateInfo = null;
  const eb = substituted.target?.expectedBounds;
  if (eb && typeof eb.pctX === 'number' && typeof eb.pctY === 'number') {
    try {
      const vp = await getViewport(bridge);
      const vpX = Math.round((eb.pctX / 100) * vp.w);
      const vpY = Math.round((eb.pctY / 100) * vp.h);
      const offset = await getChromeOffset(bridge);
      coordinateInfo = {
        pctX: eb.pctX,
        pctY: eb.pctY,
        viewportX: vpX,
        viewportY: vpY,
        screenX: vpX + offset.x,
        screenY: vpY + offset.y,
        chromeOffset: { x: offset.x, y: offset.y, dpr: offset.dpr, raw: offset.raw },
        viewport: vp,
        recordedViewport: eb.viewportW && eb.viewportH ? { w: eb.viewportW, h: eb.viewportH } : null,
      };
    } catch {}
  }

  // Execute the step
  try {
    await executeStep(bridge, substituted, variables, { log, signal });
    return { success: true, coordinateInfo };
  } catch (err) {
    return { success: false, error: err?.message || String(err), coordinateInfo };
  }
}

module.exports = {
  discoverWorkflows,
  mapPostToVariables,
  checkVariableCoverage,
  executeWorkflow,
  executePipeline,
  executeSingleStep,
  substituteObject,
};
