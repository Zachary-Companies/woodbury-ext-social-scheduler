/**
 * Posting Engine — Scripted browser automation for social media posting.
 *
 * Executes deterministic platform scripts that define a sequence of steps.
 * Bridge-capable steps (click, find, wait) run directly via the Chrome bridge.
 * Non-bridge steps (navigate, file_dialog, keyboard) pause and return a compact
 * instruction for the agent to execute, then resume via social_post_continue.
 *
 * This eliminates ~10x LLM token usage vs. having the agent interpret
 * a posting-flow.md at every step.
 */

const crypto = require('crypto');

const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

class PostingEngine {
  /**
   * @param {object} bridgeServer - ctx.bridgeServer from extension context
   * @param {object} script - Platform script definition (from scripts/{platform}.js)
   * @param {object} variables - Runtime variables (captionText, imagePath, postId, etc.)
   * @param {object} [options]
   * @param {string} [options.sessionId] - Existing session ID (for resuming)
   * @param {number} [options.stepIndex] - Step to resume from
   * @param {Function} [options.log] - Logging function
   */
  constructor(bridgeServer, script, variables, options = {}) {
    this.bridge = bridgeServer;
    this.script = script;
    this.variables = variables;
    this.stepIndex = options.stepIndex || 0;
    this.sessionId = options.sessionId || crypto.randomUUID();
    this.status = 'running'; // running | paused | success | failed
    this.log = options.log || (() => {});
  }

  /**
   * Execute steps until we hit a pause point (agent-required step),
   * reach the end (success), or encounter an error (failed).
   *
   * @returns {{ status: string, agentInstruction?: object, waitAfter?: number, error?: string, step?: number }}
   */
  async runUntilPause() {
    // Check bridge connection
    if (!this.bridge.isConnected) {
      return {
        status: 'failed',
        error: 'Chrome bridge is not connected. Make sure the Woodbury Bridge Chrome extension is installed and connected.',
        step: this.stepIndex,
      };
    }

    while (this.stepIndex < this.script.steps.length) {
      const step = this.script.steps[this.stepIndex];

      // Check conditional — skip step if condition not met
      if (step.conditional && !this._checkCondition(step.conditional)) {
        this.log(`Step ${this.stepIndex + 1}/${this.script.steps.length}: SKIP (${step.label || step.type}) — condition "${step.conditional}" not met`);
        this.stepIndex++;
        continue;
      }

      this.log(`Step ${this.stepIndex + 1}/${this.script.steps.length}: ${step.type}${step.label ? ' (' + step.label + ')' : ''}`);

      try {
        const result = await this._executeStep(step);

        if (result) {
          // Step returned a result (pause, fail, etc.)
          return result;
        }

        // Step completed, move to next
        this.stepIndex++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`Step ${this.stepIndex + 1} error: ${msg}`);
        return {
          status: 'failed',
          error: `Step ${this.stepIndex + 1} failed: ${msg}`,
          step: this.stepIndex,
        };
      }
    }

    // All steps completed
    return { status: 'success' };
  }

  /**
   * Execute a single step. Returns null if the step completed and we should
   * continue, or returns a result object if we need to pause/fail.
   */
  async _executeStep(step) {
    switch (step.type) {
      case 'bridge':
        return await this._executeBridgeStep(step);

      case 'wait':
        await this._sleep(step.ms || 1000);
        return null;

      case 'checkpoint':
        return await this._executeCheckpoint(step);

      case 'navigate':
        return this._createPause({
          tool: 'mcp__woodbury-browser__browser',
          params: { action: 'open', url: step.url, waitMs: step.waitMs || 3000 },
        }, step.waitAfter);

      case 'file_dialog': {
        const filePath = this._resolveVar(step.pathVar);
        if (!filePath) {
          return { status: 'failed', error: `No file path for variable: ${step.pathVar}`, step: this.stepIndex };
        }
        return this._createPause({
          tool: 'mcp__woodbury-browser__file_dialog',
          params: { filePath },
        }, step.waitAfter || 2000);
      }

      case 'keyboard_type': {
        const text = this._resolveVar(step.textVar);
        if (!text) {
          return { status: 'failed', error: `No text for variable: ${step.textVar}`, step: this.stepIndex };
        }
        return this._createPause({
          tool: 'mcp__woodbury-browser__keyboard',
          params: { action: 'type', text },
        }, step.waitAfter);
      }

      default:
        return { status: 'failed', error: `Unknown step type: ${step.type}`, step: this.stepIndex };
    }
  }

  /**
   * Execute a bridge step — find elements, click, set values, etc.
   * Supports retry and fallback chains.
   */
  async _executeBridgeStep(step) {
    const attempts = [
      { action: step.action, params: step.params },
      ...(step.fallback || []),
    ];
    const maxRetries = step.retry?.count || 0;
    const retryDelay = step.retry?.delayMs || 1000;

    for (const attempt of attempts) {
      for (let retry = 0; retry <= maxRetries; retry++) {
        try {
          if (retry > 0) {
            this.log(`  Retry ${retry}/${maxRetries} after ${retryDelay}ms...`);
            await this._sleep(retryDelay);
          }

          const result = await this.bridge.send(attempt.action, attempt.params || {});

          // If the step needs to extract a result and click
          if (step.then === 'click') {
            const selector = this._extractSelector(result, attempt);
            if (!selector) {
              if (retry < maxRetries) continue;
              // Try next fallback
              break;
            }
            await this.bridge.send('click_element', { selector });
          }

          // Step succeeded
          return null;
        } catch (err) {
          if (retry < maxRetries) continue;
          // Try next fallback
          break;
        }
      }
    }

    // All attempts exhausted
    return {
      status: 'failed',
      error: `Bridge step failed: ${step.action} ${JSON.stringify(step.params)}. Could not find or interact with the element.`,
      step: this.stepIndex,
    };
  }

  /**
   * Execute a checkpoint — query the bridge and check a pass/fail condition.
   */
  async _executeCheckpoint(step) {
    try {
      const result = await this.bridge.send(step.bridge.action, step.bridge.params || {});
      const found = this._resultHasElements(result);

      const shouldFail =
        (step.failIf === 'found' && found) ||
        (step.failIf === 'not_found' && !found);

      if (shouldFail) {
        return {
          status: 'failed',
          error: step.failMessage || `Checkpoint "${step.label || 'unnamed'}" failed`,
          step: this.stepIndex,
        };
      }

      // Checkpoint passed
      return null;
    } catch (err) {
      // If the bridge call itself fails (e.g., element not found throws),
      // treat "not found" as the element not existing
      if (step.failIf === 'found') {
        // Element not found = good (we wanted it NOT to be found)
        return null;
      }
      return {
        status: 'failed',
        error: step.failMessage || `Checkpoint bridge call failed: ${err.message || err}`,
        step: this.stepIndex,
      };
    }
  }

  /**
   * Create a pause result that tells the agent to execute one MCP call.
   */
  _createPause(agentInstruction, waitAfter) {
    this.stepIndex++;
    this.status = 'paused';
    return {
      status: 'paused',
      agentInstruction,
      waitAfter: waitAfter || 0,
      step: this.stepIndex - 1,
    };
  }

  /**
   * Extract a CSS selector from a bridge result.
   * Handles the various result shapes from different bridge actions.
   */
  _extractSelector(result, attempt) {
    // find_interactive returns { results: [{ selector, ... }] }
    if (result?.results && Array.isArray(result.results) && result.results.length > 0) {
      return result.results[0].selector || null;
    }
    // find_element_by_text / find_elements returns array of elements
    if (Array.isArray(result) && result.length > 0) {
      return result[0].selector || null;
    }
    // Some actions return a single element
    if (result?.selector) {
      return result.selector;
    }
    return null;
  }

  /**
   * Check if a bridge result contains any found elements.
   */
  _resultHasElements(result) {
    if (result?.results && Array.isArray(result.results)) {
      return result.results.length > 0;
    }
    if (Array.isArray(result)) {
      return result.length > 0;
    }
    if (result && typeof result === 'object' && result.selector) {
      return true;
    }
    return false;
  }

  /**
   * Check if a conditional is satisfied.
   * Supported conditions:
   * - 'hasImage' — true if variables.imagePath is set
   */
  _checkCondition(condition) {
    switch (condition) {
      case 'hasImage':
        return !!this.variables.imagePath;
      default:
        // Unknown condition — treat as true (execute the step)
        return true;
    }
  }

  /**
   * Resolve a variable name to its value.
   */
  _resolveVar(varName) {
    return this.variables[varName] || null;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Serialize engine state for persistence between agent calls.
   */
  toJSON() {
    return {
      sessionId: this.sessionId,
      scriptPlatform: this.script.platform,
      stepIndex: this.stepIndex,
      variables: this.variables,
      status: this.status,
      createdAt: this._createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Create an engine from persisted state.
   *
   * @param {object} state - Deserialized session state
   * @param {object} bridgeServer - ctx.bridgeServer
   * @param {object} scriptsDir - Path to scripts directory
   * @param {Function} [log] - Logging function
   * @returns {PostingEngine|null}
   */
  static fromState(state, bridgeServer, scriptsDir, log) {
    const fs = require('fs');
    const path = require('path');

    // Check expiry
    const updatedAt = new Date(state.updatedAt || state.createdAt);
    if (Date.now() - updatedAt.getTime() > SESSION_TIMEOUT_MS) {
      return null; // expired
    }

    // Load the script
    const scriptPath = path.join(scriptsDir, `${state.scriptPlatform}.js`);
    if (!fs.existsSync(scriptPath)) {
      return null;
    }

    // Clear require cache so script changes are picked up
    delete require.cache[require.resolve(scriptPath)];
    const script = require(scriptPath);

    const engine = new PostingEngine(bridgeServer, script, state.variables, {
      sessionId: state.sessionId,
      stepIndex: state.stepIndex,
      log: log || (() => {}),
    });
    engine._createdAt = state.createdAt;
    return engine;
  }
}

module.exports = { PostingEngine, SESSION_TIMEOUT_MS };
