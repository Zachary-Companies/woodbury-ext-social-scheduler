/**
 * Social Scheduler — Woodbury Extension
 *
 * Provides tools, slash commands, and system prompt for scheduling
 * and automating social media posting via browser automation.
 *
 * Auto-starts the Next.js scheduler web app on activation
 * and shuts it down on deactivation.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const http = require('http');
const storage = require('./lib/storage-client.js');
const { PostingEngine } = require('./lib/posting-engine.js');
const workflowRunner = require('./lib/workflow-runner.js');

// Module-level state for the web app process
let webAppProcess = null;
let webAppUrl = null;
let webAppPort = 3001;


/**
 * Find the social-scheduler Next.js app directory.
 * Looks relative to the Woodbury repo root.
 */
function findWebAppDir() {
  // The extension is at ~/.woodbury/extensions/social-scheduler/
  // The web app is at <woodbury-repo>/apps/social-scheduler/
  // We need to find the woodbury repo. Try common locations:
  const candidates = [
    // If SOCIAL_SCHEDULER_APP_DIR is set, use it
    process.env.SOCIAL_SCHEDULER_APP_DIR,
    // Standard location relative to where woodbury is typically checked out
    path.join(require('os').homedir(), 'Documents', 'GitHub', 'woodbury', 'apps', 'social-scheduler'),
    // Check if we're in the repo (cwd-based)
    path.join(process.cwd(), 'apps', 'social-scheduler'),
    // Resolve from the main woodbury module
  ].filter(Boolean);

  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
  }
  return null;
}

/**
 * Wait for the dev server to be ready by polling the URL.
 */
function waitForServer(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const check = () => {
      if (Date.now() - startTime > timeoutMs) {
        resolve(false); // Don't reject, just indicate not ready yet
        return;
      }

      http.get(url, (res) => {
        // Any response means the server is up (even redirects)
        resolve(true);
      }).on('error', () => {
        // Server not ready yet, try again
        setTimeout(check, 500);
      });
    };

    // Give the process a moment to start
    setTimeout(check, 1000);
  });
}

/** @type {import('woodbury').WoodburyExtension} */
module.exports = {
  async activate(ctx) {
    const env = ctx.env;

    // ─── Auto-start Next.js web app ─────────────────────────────────
    const appDir = findWebAppDir();
    webAppPort = parseInt(env.SOCIAL_SCHEDULER_PORT || '3001', 10);
    webAppUrl = env.SOCIAL_SCHEDULER_WEB_URL || `http://localhost:${webAppPort}`;

    if (appDir) {
      try {
        // Check if something is already running on the port
        const alreadyRunning = await new Promise((resolve) => {
          http.get(webAppUrl, () => resolve(true)).on('error', () => resolve(false));
        });

        if (alreadyRunning) {
          ctx.log.info(`Scheduler web app already running at ${webAppUrl}`);
        } else {
          // Spawn the Next.js dev server
          ctx.log.info(`Starting scheduler web app from ${appDir}...`);

          // Merge extension env vars (from Woodbury Config Dashboard) into the
          // child process so the Next.js API routes can read ANTHROPIC_API_KEY,
          // GEMINI_API_KEY, etc. via process.env
          const childEnv = { ...process.env, ...env, PORT: String(webAppPort) };

          webAppProcess = spawn('npx', ['next', 'dev', '-p', String(webAppPort)], {
            cwd: appDir,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
            env: childEnv,
          });

          // Log stdout/stderr but don't flood the console
          webAppProcess.stdout.on('data', (data) => {
            const line = data.toString().trim();
            if (line.includes('Ready') || line.includes('ready') || line.includes('started')) {
              ctx.log.info(`Scheduler: ${line}`);
            }
          });

          webAppProcess.stderr.on('data', (data) => {
            const line = data.toString().trim();
            // Next.js puts some normal output on stderr
            if (line && !line.includes('ExperimentalWarning') && !line.includes('warn')) {
              ctx.log.debug(`Scheduler stderr: ${line}`);
            }
          });

          webAppProcess.on('error', (err) => {
            ctx.log.error(`Scheduler web app failed to start: ${err.message}`);
            webAppProcess = null;
          });

          webAppProcess.on('exit', (code, signal) => {
            if (code !== null && code !== 0) {
              ctx.log.warn(`Scheduler web app exited with code ${code}`);
            }
            webAppProcess = null;
          });

          // Wait for the server to be ready (up to 30 seconds)
          const ready = await waitForServer(webAppUrl, 30000);
          if (ready) {
            ctx.log.info(`Scheduler web app ready at ${webAppUrl}`);
          } else {
            ctx.log.warn(`Scheduler web app may still be starting at ${webAppUrl}`);
          }

          // Write status file so the config dashboard can show a launch button
          try {
            const statusFile = path.join(__dirname, '.webui-status.json');
            fs.writeFileSync(statusFile, JSON.stringify({
              url: webAppUrl,
              port: webAppPort,
              label: 'Social Scheduler Dashboard',
              running: true,
              startedAt: new Date().toISOString()
            }, null, 2));
          } catch {
            // Non-critical
          }
        }
      } catch (err) {
        ctx.log.error(`Failed to start scheduler web app: ${err.message}`);
      }
    } else {
      ctx.log.info('Scheduler web app directory not found — web UI not started. Use /social dashboard for URL.');
    }

    // Load site-knowledge for system prompt
    const siteKnowledgeDir = path.join(__dirname, 'site-knowledge');
    const platformPrompts = loadSiteKnowledge(siteKnowledgeDir);

    // ─── System Prompt ───────────────────────────────────────────────
    ctx.addSystemPrompt(`## Social Scheduler Extension

You have access to social media scheduling and posting tools. Posts are stored locally at ~/.woodbury/social-scheduler/posts/ as JSON files.

### Available Tools
- \`social_list_posts\` — List posts filtered by status, platform, or date range
- \`social_get_post\` — Get a single post by ID (returns full JSON)
- \`social_create_post\` — Create a new post (text, platforms, scheduledAt, tags, imagePrompt)
- \`social_attach_image\` — Attach a generated image file to a post
- \`social_attach_video\` — Attach a rendered video file to a post (for YouTube)
- \`social_post_now\` — Post a single item to one platform (uses scripted engine for efficiency)
- \`social_post_continue\` — Continue a scripted posting session after executing a command
- \`social_post_due\` — Post all scheduled items that are now due
- \`social_generate\` — Generate post text or images via AI

### Supported Platforms
- **Instagram** — Image posts with captions (requires image)
- **Twitter/X** — Text posts with optional image
- **YouTube** — Video uploads with title and description (requires video)

### Image Generation Workflow
For image posts (Instagram, Twitter):
1. Call \`social_create_post\` with an \`imagePrompt\` parameter describing the image
2. The tool returns instructions to call \`nanobanana\` with the prompt and the correct outputPath
3. Call \`nanobanana\` (action="generate") with the prompt and outputPath from those instructions
4. Call \`social_attach_image\` with the postId and the filename from nanobanana's output
5. Now the post has an image and is ready to be posted

### Video Creation Workflow
For video posts (YouTube):
1. Call \`social_create_post\` with text (description) and platforms: ["youtube"]
2. Use \`tts_speak\` to generate voiceover audio from a narration script
3. Use \`nanobanana\` to generate images/slides for the video
4. Use \`video_render\` to assemble images + audio into a rendered video via Blender
5. Call \`social_attach_video\` with the postId and video file path
6. Call \`social_post_now\` with platform="youtube" to upload

When creating a post, ALWAYS include an \`imagePrompt\` describing a suitable image. This triggers the image generation workflow.
If \`social_post_now\` is called and the post has no image (e.g. for Instagram which requires one), it will instruct you to generate one via nanobanana first.
If \`social_post_now\` is called for YouTube and the post has no video, it will instruct you to create one using the video pipeline.

### Common Requests → Tool Mapping
- "post the scheduled items" / "post what's due" → \`social_post_due\`
- "create a post about X for Instagram" → \`social_create_post\` with \`imagePrompt\`
- "create a YouTube video about X" → \`social_create_post\` + tts_speak + nanobanana + video_render + social_attach_video
- "what's scheduled this week?" → \`social_list_posts\` with date range
- "show me today's posts" → \`social_list_posts\` with today's date
- "generate a caption about Y" → \`social_generate\` with type="text"
- "make an image for my post" → \`social_generate\` with type="image" and postId

### Scripted Posting Flow
When \`social_post_now\` is called, it runs a scripted posting engine that automates most browser
interactions directly via the Chrome bridge. You only need to execute a few specific commands:

1. Call \`social_post_now\` with the post ID and platform
2. The tool returns a SINGLE browser command to execute (navigate URL, file_dialog, or keyboard type)
3. Execute that exact command verbatim — do NOT try to interpret or modify it
4. Call \`social_post_continue\` with the session ID from the response
5. Repeat steps 2-4 until the tool reports success or failure

The engine handles all element finding, clicking, waiting, and verification internally.
You only execute the 2-3 commands the engine cannot do itself (URL navigation, OS file picker, typing).

If no scripted flow exists for a platform, the tool falls back to returning a full posting-flow.md
for you to follow step-by-step using browser_query, mouse, keyboard, and file_dialog tools.

### Workflow Integration
The social scheduler can discover and run Woodbury workflows (.workflow.json files) that automate browser tasks:

- \`social_list_workflows\` — Discover available workflows (from extensions, project, global)
- \`social_run_workflow\` — Execute a workflow with post data automatically mapped to variables
- \`social_check_workflow\` — Check variable compatibility before running

**CRITICAL: Workflow execution is FULLY AUTONOMOUS.** When you call \`social_run_workflow\`, the tool handles ALL browser automation internally — it navigates, clicks, types, waits, and verifies entirely on its own via the Chrome bridge. You MUST NOT use browser_query, mouse, keyboard, vision_analyze, browser, or any other browser tool while a workflow is running or after calling social_run_workflow. Just call the tool, wait for it to return a result, and report the outcome to the user. The workflow script drives the browser — not you.

**When the user asks to "run a workflow" or mentions a workflow by name (e.g. "run create-song", "use the create-song workflow", "social_run_workflow with workflowId=..."), ALWAYS call social_run_workflow. Do NOT interpret the request as a manual browser task.**

**Auto-mapping:** When you provide a postId to \`social_run_workflow\`, the post's text, imagePath, videoPath, etc. are automatically mapped to matching workflow variables. Common aliases are supported (caption → text, image → imagePath, etc.).

**Chaining/Pipelines:** Use the \`pipeline\` parameter to chain multiple workflows. Output variables from each workflow are passed to the next:
\`\`\`json
{
  "pipeline": [
    { "workflowId": "create-song", "variables": { "lyrics": "Hello world" } },
    { "workflowId": "download-song" },
    { "workflowId": "create-video", "variables": { "audioPath": "{{songPath}}" } }
  ]
}
\`\`\`

**Common Workflow Patterns:**
- "use the create-song workflow" → \`social_list_workflows\` (find it) → \`social_run_workflow\` with variables
- "run all the workflows for this post" → \`social_list_workflows\` → check compatibility → chain in pipeline
- "create a song, download it, and make a video" → pipeline with 3 workflows
- "what workflows work with my instagram post?" → \`social_check_workflow\` for each

### Important
- The user MUST be logged into each social media platform before posting
- If a posting flow fails, mark it as failed and report the error — do NOT retry without user permission
- The scheduler web UI is at: ${webAppUrl}

${platformPrompts}`);

    // ─── Tools ───────────────────────────────────────────────────────

    // social_list_posts
    ctx.registerTool(
      {
        name: 'social_list_posts',
        description: 'List scheduled social media posts. Filter by status (draft/scheduled/posted/failed), platform, date range, or tag.',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', description: 'Filter by status: draft, scheduled, posting, posted, partial, failed', enum: ['draft', 'scheduled', 'posting', 'posted', 'partial', 'failed'] },
            platform: { type: 'string', description: 'Filter by platform name (e.g., "instagram", "twitter")' },
            from: { type: 'string', description: 'Start date (ISO 8601) for date range filter' },
            to: { type: 'string', description: 'End date (ISO 8601) for date range filter' },
            tag: { type: 'string', description: 'Filter by tag' }
          }
        }
      },
      async (params) => {
        const posts = storage.listPosts(env, params);
        if (posts.length === 0) {
          return '# No Posts Found\n\nNo posts match the given filters.';
        }
        const lines = posts.map(p => {
          const platforms = p.platforms.filter(pt => pt.enabled).map(pt => pt.platform).join(', ');
          const date = p.scheduledAt ? new Date(p.scheduledAt).toLocaleString() : 'Not scheduled';
          const text = p.content.text.slice(0, 80) + (p.content.text.length > 80 ? '...' : '');
          return `- **${p.id.slice(0, 8)}** [${p.status}] ${date} → ${platforms}\n  "${text}"`;
        });
        return `# Posts (${posts.length})\n\n${lines.join('\n\n')}`;
      }
    );

    // social_get_post
    ctx.registerTool(
      {
        name: 'social_get_post',
        description: 'Get a single social media post by ID. Returns the full post data including content, schedule, platform status, and media attachments.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Post ID (UUID)' }
          },
          required: ['id']
        }
      },
      async (params) => {
        const post = storage.getPost(env, params.id);
        if (!post) {
          return `# Post Not Found\n\nNo post with ID: ${params.id}`;
        }
        return `# Post: ${post.id.slice(0, 8)}\n\n\`\`\`json\n${JSON.stringify(post, null, 2)}\n\`\`\``;
      }
    );

    // social_create_post
    ctx.registerTool(
      {
        name: 'social_create_post',
        description: 'Create a new social media post. Provide the text content, target platforms, and optional schedule. If imagePrompt is provided, an image is auto-generated via AI and attached to the post.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The post text/caption content' },
            platforms: {
              type: 'array',
              items: { type: 'string' },
              description: 'Target platforms (e.g., ["instagram", "twitter"])'
            },
            scheduledAt: { type: 'string', description: 'When to post (ISO 8601 datetime). Omit for draft.' },
            timezone: { type: 'string', description: 'IANA timezone (default: America/New_York)' },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tags for organization'
            },
            imagePrompt: { type: 'string', description: 'If provided, an AI image is generated with this prompt and attached to the post. Describe the image you want (e.g., "A vibrant flat-lay of fresh coffee beans on a marble surface").' }
          },
          required: ['text', 'platforms']
        }
      },
      async (params) => {
        const post = storage.createPost(env, params);
        const mediaDir = path.join(storage.getMediaDir(env), post.id);
        storage.ensureDir(mediaDir);

        let result = `# Post Created\n\n- **ID:** ${post.id}\n- **Status:** ${post.status}\n- **Platforms:** ${post.platforms.map(p => p.platform).join(', ')}\n- **Scheduled:** ${post.scheduledAt || 'Draft (not scheduled)'}\n- **Text:** "${post.content.text.slice(0, 100)}${post.content.text.length > 100 ? '...' : ''}"`;

        if (params.imagePrompt) {
          result += `\n\n## NEXT STEP — Generate Image\n\nYou MUST now generate an image for this post. Call the \`nanobanana\` tool with:\n- **action:** "generate"\n- **prompt:** "${params.imagePrompt}"\n- **outputPath:** "${mediaDir}"\n- **aspectRatio:** "4:5" (best for Instagram) or "1:1"\n\nAfter the image is generated, call \`social_attach_image\` with the post ID and the filename that nanobanana saved.`;
        }

        return result;
      }
    );

    // Scripts directory for the posting engine
    const scriptsDir = path.join(__dirname, 'scripts');

    // Helper: format an engine pause result into agent instructions
    function formatEngineResult(engineResult, engine, script, postId) {
      if (engineResult.status === 'success') {
        // Update post status to posted
        const post = storage.getPost(env, postId);
        if (post) {
          const updatedPlatforms = post.platforms.map(p =>
            p.status === 'posting' ? { ...p, status: 'posted' } : p
          );
          const allPosted = updatedPlatforms.every(p => !p.enabled || p.status === 'posted');
          storage.updatePost(env, postId, {
            status: allPosted ? 'posted' : 'partial',
            platforms: updatedPlatforms,
          });
        }
        storage.deletePostingSession(env, engine.sessionId);
        return `# Post Published Successfully\n\nThe scripted posting flow completed. The post has been shared.`;
      }

      if (engineResult.status === 'failed') {
        const post = storage.getPost(env, postId);
        if (post) {
          storage.updatePost(env, postId, {
            status: 'failed',
            platforms: post.platforms.map(p =>
              p.status === 'posting' ? { ...p, status: 'failed', error: engineResult.error } : p
            ),
          });
        }
        storage.deletePostingSession(env, engine.sessionId);
        return `# Posting Failed\n\n**Error:** ${engineResult.error}\n\nStep ${(engineResult.step || 0) + 1} of ${script.steps.length} failed.`;
      }

      if (engineResult.status === 'paused') {
        // Save session state for continuation
        storage.savePostingSession(env, engine.sessionId, engine.toJSON());

        const instr = engineResult.agentInstruction;
        const stepLabel = script.steps[engineResult.step]?.label || `Step ${engineResult.step + 1}`;
        const progress = `${engineResult.step + 1}/${script.steps.length}`;

        let instruction = `# Posting Script — Execute Command\n\n`;
        instruction += `**Session:** \`${engine.sessionId}\`\n`;
        instruction += `**Progress:** ${progress} — ${stepLabel}\n\n`;
        instruction += `## Execute this command now:\n\n`;
        instruction += `\`${instr.tool}\`\n\`\`\`json\n${JSON.stringify(instr.params, null, 2)}\n\`\`\`\n\n`;

        if (engineResult.waitAfter) {
          instruction += `Wait ${engineResult.waitAfter}ms after executing.\n\n`;
        }

        instruction += `## Then continue:\nCall \`social_post_continue\` with sessionId=\`${engine.sessionId}\``;
        return instruction;
      }

      return `# Error\n\nUnexpected engine status: ${engineResult.status}`;
    }

    // social_post_now
    ctx.registerTool(
      {
        name: 'social_post_now',
        description: 'Post a single scheduled item to one platform. Uses a scripted posting engine that automates most browser interactions directly. You only need to execute the few commands it returns (navigate, file_dialog, keyboard type), then call social_post_continue to resume.',
        dangerous: true,
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Post ID to post' },
            platform: { type: 'string', description: 'Platform to post to (e.g., "instagram", "twitter")' }
          },
          required: ['id', 'platform']
        }
      },
      async (params) => {
        const post = storage.getPost(env, params.id);
        if (!post) {
          return `# Error\n\nPost not found: ${params.id}`;
        }

        const platformTarget = post.platforms.find(p => p.platform === params.platform);
        if (!platformTarget) {
          return `# Error\n\nPost ${params.id.slice(0, 8)} is not configured for platform: ${params.platform}`;
        }

        // Build media paths
        const mediaDir = storage.getMediaDir(env);
        const postMediaDir = path.join(mediaDir, post.id);
        const imagePaths = post.content.images.map(img =>
          path.join(postMediaDir, img.filename)
        );

        // Check if we need to generate an image first (Instagram requires one)
        const platformsRequiringImages = ['instagram'];
        const needsImage = post.content.images.length === 0 && platformsRequiringImages.includes(params.platform);

        if (needsImage) {
          storage.ensureDir(postMediaDir);
          return `# Image Required Before Posting

This post has NO image, but ${params.platform} requires one. Generate an image first:

1. Call \`nanobanana\` with:
   - **action:** "generate"
   - **prompt:** "Create an engaging social media image for: ${post.content.text.slice(0, 150)}"
   - **outputPath:** "${postMediaDir}"
   - **aspectRatio:** "4:5"
2. Call \`social_attach_image\` with postId="${post.id}" and the filename from nanobanana
3. Then call \`social_post_now\` again with the same ID and platform`;
        }

        // Check if YouTube needs a video
        const platformsRequiringVideo = ['youtube'];
        const needsVideo = !post.content.video && platformsRequiringVideo.includes(params.platform);

        if (needsVideo) {
          return `# Video Required Before Posting

This post has NO video, but ${params.platform} requires one. Create a video first:

1. Use \`tts_speak\` to generate narration audio from the post text
2. Use \`nanobanana\` to generate images for the video
3. Use \`video_render\` to assemble images + audio into a video
4. Use \`social_attach_video\` with postId="${post.id}" and the output video path
5. Then call \`social_post_now\` again with the same ID and platform`;
        }

        // Get platform-specific text
        const platformText = post.content.platformOverrides[params.platform]?.text || post.content.text;
        const hashtags = post.content.platformOverrides[params.platform]?.hashtags;
        const fullText = hashtags ? `${platformText}\n\n${hashtags.map(h => `#${h}`).join(' ')}` : platformText;

        // Try scripted engine first
        const scriptPath = path.join(scriptsDir, `${params.platform}.js`);
        if (fs.existsSync(scriptPath)) {
          // Clear require cache so changes are picked up
          delete require.cache[require.resolve(scriptPath)];
          const script = require(scriptPath);

          // Build variables for the engine
          const videoData = post.content.video;
          const variables = {
            captionText: fullText,
            postText: fullText,
            imagePath: imagePaths.length > 0 ? imagePaths[0] : null,
            videoPath: videoData ? videoData.path : null,
            titleText: videoData?.title || fullText.slice(0, 100),
            postId: post.id,
          };

          // Update status to posting
          storage.updatePost(env, params.id, {
            status: 'posting',
            platforms: post.platforms.map(p =>
              p.platform === params.platform ? { ...p, status: 'posting' } : p
            )
          });

          // Clean up any expired sessions
          storage.cleanExpiredSessions(env);

          const engine = new PostingEngine(ctx.bridgeServer, script, variables, {
            log: (msg) => ctx.log.info(`[posting-engine] ${msg}`),
          });

          const result = await engine.runUntilPause();
          return formatEngineResult(result, engine, script, post.id);
        }

        // Fallback: no script — use old posting-flow.md approach
        const flowPath = path.join(siteKnowledgeDir, params.platform, 'posting-flow.md');
        let postingFlow = '';
        if (fs.existsSync(flowPath)) {
          postingFlow = fs.readFileSync(flowPath, 'utf-8');
        }

        storage.updatePost(env, params.id, {
          status: 'posting',
          platforms: post.platforms.map(p =>
            p.platform === params.platform ? { ...p, status: 'posting' } : p
          )
        });

        return `# Post to ${params.platform}: ${post.id.slice(0, 8)} (Manual Flow)

## Content
**Text:** ${fullText}
**Images:** ${imagePaths.length > 0 ? imagePaths.map(p => `\`${p}\``).join(', ') : 'None'}

## Posting Flow
${postingFlow || `No posting-flow.md found for "${params.platform}". Use browser_query and mouse/keyboard to navigate the platform manually.`}

## After Posting
Report success or failure. The post status will be updated automatically.`;
      }
    );

    // social_post_continue — resume a scripted posting session
    ctx.registerTool(
      {
        name: 'social_post_continue',
        description: 'Continue a scripted posting session after executing the command from social_post_now or a previous social_post_continue call. Pass the session ID to resume.',
        dangerous: true,
        parameters: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: 'The posting session ID from the previous response' }
          },
          required: ['sessionId']
        }
      },
      async (params) => {
        const sessionState = storage.loadPostingSession(env, params.sessionId);
        if (!sessionState) {
          return `# Error\n\nPosting session not found or expired: ${params.sessionId}\n\nSessions expire after 10 minutes. Start a new posting attempt with \`social_post_now\`.`;
        }

        const engine = PostingEngine.fromState(sessionState, ctx.bridgeServer, scriptsDir, (msg) => {
          ctx.log.info(`[posting-engine] ${msg}`);
        });

        if (!engine) {
          storage.deletePostingSession(env, params.sessionId);
          return `# Error\n\nCould not restore posting session. The platform script may have been removed. Start a new attempt with \`social_post_now\`.`;
        }

        // Load the script for step count reference
        const scriptPath = path.join(scriptsDir, `${sessionState.scriptPlatform}.js`);
        delete require.cache[require.resolve(scriptPath)];
        const script = require(scriptPath);

        const result = await engine.runUntilPause();
        return formatEngineResult(result, engine, script, sessionState.variables.postId);
      }
    );

    // social_post_due
    ctx.registerTool(
      {
        name: 'social_post_due',
        description: 'Find and post all social media items that are scheduled and due now. Lists the due posts and their target platforms. Use social_post_now for each one.',
        parameters: {
          type: 'object',
          properties: {
            dryRun: { type: 'boolean', description: 'If true, just list due posts without posting', default: false }
          }
        }
      },
      async (params) => {
        const duePosts = storage.getDuePosts(env);

        if (duePosts.length === 0) {
          return '# No Due Posts\n\nThere are no scheduled posts due for posting right now.';
        }

        const lines = duePosts.map(p => {
          const platforms = p.platforms.filter(pt => pt.enabled && pt.status === 'pending')
            .map(pt => pt.platform).join(', ');
          return `- **${p.id.slice(0, 8)}** scheduled ${new Date(p.scheduledAt).toLocaleString()} → ${platforms}\n  "${p.content.text.slice(0, 60)}..."`;
        });

        if (params.dryRun) {
          return `# Due Posts (Dry Run) — ${duePosts.length} posts\n\n${lines.join('\n\n')}\n\n_Dry run — no posts were made. Remove dryRun to post._`;
        }

        return `# Due Posts — ${duePosts.length} to post\n\n${lines.join('\n\n')}\n\n**Action:** Use \`social_post_now\` for each post+platform combination above. Post them one at a time and wait for each to complete before starting the next.`;
      }
    );

    // social_generate
    ctx.registerTool(
      {
        name: 'social_generate',
        description: 'Generate social media content using AI. For text: generates captions/posts with optional tone and platform formatting. For images: generates images using AI image generation.',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['text', 'image'], description: 'What to generate: "text" for captions/posts, "image" for images' },
            prompt: { type: 'string', description: 'Description of what to generate' },
            platforms: { type: 'array', items: { type: 'string' }, description: 'Target platforms (affects formatting, char limits, hashtags)' },
            tone: { type: 'string', description: 'Tone for text: professional, casual, humorous, inspirational' },
            postId: { type: 'string', description: 'For images: post ID to attach the image to' }
          },
          required: ['type', 'prompt']
        }
      },
      async (params) => {
        if (params.type === 'text') {
          // Return a prompt for the agent to generate with its own LLM capabilities
          const platformInfo = (params.platforms || []).map(p => {
            const limits = { instagram: 2200, twitter: 280, facebook: 63206, linkedin: 3000, tiktok: 2200 };
            return `${p}: max ${limits[p] || 5000} chars`;
          }).join(', ');

          return `# Generate Social Media Text

**Prompt:** ${params.prompt}
**Tone:** ${params.tone || 'casual'}
**Platforms:** ${platformInfo || 'general'}

Please generate the post text now. Consider:
- Platform character limits (${platformInfo || 'varies by platform'})
- Include relevant hashtags if appropriate
- Adjust tone to "${params.tone || 'casual'}"
- If multiple platforms, create platform-specific variations where needed (e.g., shorter for Twitter)

After generating, use \`social_create_post\` to save the post, or return the text for the user to review.`;
        } else if (params.type === 'image') {
          if (!params.postId) {
            return `# Error\n\npostId is required for image generation. Create a post first with \`social_create_post\`, then pass its ID here to generate and attach an image.`;
          }

          const post = storage.getPost(env, params.postId);
          if (!post) {
            return `# Error\n\nPost not found: ${params.postId}`;
          }

          const mediaDir = path.join(storage.getMediaDir(env), params.postId);
          storage.ensureDir(mediaDir);

          return `# Generate Image for Post ${params.postId.slice(0, 8)}

Call the \`nanobanana\` tool now:
- **action:** "generate"
- **prompt:** "${params.prompt}"
- **outputPath:** "${mediaDir}"
- **aspectRatio:** "4:5" (or "1:1" for square)

After nanobanana returns the image, call \`social_attach_image\` with:
- **postId:** "${params.postId}"
- **filename:** (the filename from nanobanana's output)`;
        }
        return '# Error\n\ntype must be "text" or "image"';
      }
    );

    // social_attach_image
    ctx.registerTool(
      {
        name: 'social_attach_image',
        description: 'Attach a generated image file to a post. Call this after using nanobanana to generate an image into the post\'s media directory.',
        parameters: {
          type: 'object',
          properties: {
            postId: { type: 'string', description: 'Post ID to attach the image to' },
            filename: { type: 'string', description: 'Filename of the image (e.g., "generated-image.png") — must already exist in ~/.woodbury/social-scheduler/media/<postId>/' }
          },
          required: ['postId', 'filename']
        }
      },
      async (params) => {
        const post = storage.getPost(env, params.postId);
        if (!post) {
          return `# Error\n\nPost not found: ${params.postId}`;
        }

        const mediaDir = path.join(storage.getMediaDir(env), params.postId);
        const imagePath = path.join(mediaDir, params.filename);

        if (!fs.existsSync(imagePath)) {
          return `# Error\n\nImage file not found at: ${imagePath}\n\nMake sure nanobanana saved to outputPath="${mediaDir}"`;
        }

        // Determine mime type from extension
        const ext = path.extname(params.filename).toLowerCase();
        const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
        const mimeType = mimeTypes[ext] || 'image/png';

        const imageEntry = {
          id: crypto.randomUUID(),
          filename: params.filename,
          mimeType,
          prompt: 'Generated via nanobanana'
        };

        const updatedImages = [...(post.content.images || []), imageEntry];
        storage.updatePost(env, params.postId, {
          content: { ...post.content, images: updatedImages }
        });

        return `# Image Attached

- **Post:** ${params.postId.slice(0, 8)}
- **File:** ${params.filename}
- **Path:** ${imagePath}
- **Total images:** ${updatedImages.length}

The image is now attached to the post and will be uploaded when posting.`;
      }
    );

    // social_attach_video
    ctx.registerTool(
      {
        name: 'social_attach_video',
        description: 'Attach a rendered video file to a post. Call this after using video_render (blender-automat) to produce a video. Required for YouTube posts.',
        parameters: {
          type: 'object',
          properties: {
            postId: { type: 'string', description: 'Post ID to attach the video to' },
            videoPath: { type: 'string', description: 'Absolute path to the video file (e.g., output from video_render)' },
            title: { type: 'string', description: 'Video title (for YouTube — max 100 chars)' }
          },
          required: ['postId', 'videoPath']
        }
      },
      async (params) => {
        const post = storage.getPost(env, params.postId);
        if (!post) {
          return `# Error\n\nPost not found: ${params.postId}`;
        }

        const absPath = path.isAbsolute(params.videoPath)
          ? params.videoPath
          : path.resolve(process.cwd(), params.videoPath);

        if (!fs.existsSync(absPath)) {
          return `# Error\n\nVideo file not found at: ${absPath}`;
        }

        const videoEntry = {
          id: crypto.randomUUID(),
          path: absPath,
          filename: path.basename(absPath),
          title: params.title || '',
        };

        storage.updatePost(env, params.postId, {
          content: { ...post.content, video: videoEntry }
        });

        return `# Video Attached\n\n- **Post:** ${params.postId.slice(0, 8)}\n- **File:** ${videoEntry.filename}\n- **Path:** ${absPath}\n- **Title:** ${videoEntry.title || '(from post text)'}\n\nThe video is now attached to the post. Use \`social_post_now\` with platform="youtube" to upload it.`;
      }
    );

    // ─── Workflow Integration Tools ─────────────────────────────────

    // social_list_workflows — discover available workflows
    ctx.registerTool(
      {
        name: 'social_list_workflows',
        description: 'List available Woodbury workflows that can be used with the social scheduler. Shows workflows from extensions, project, and global locations with their variables. Use this to find workflows for posting, content generation, or any browser automation task.',
        parameters: {
          type: 'object',
          properties: {
            site: { type: 'string', description: 'Filter by site/domain (e.g., "suno.com", "instagram.com")' },
            withVariables: { type: 'boolean', description: 'If true, show variable details for each workflow', default: false },
          }
        }
      },
      async (params) => {
        const discovered = workflowRunner.discoverWorkflows(ctx.workingDirectory);

        let workflows = discovered;
        if (params.site) {
          workflows = workflows.filter(w => w.site && w.site.includes(params.site));
        }

        if (workflows.length === 0) {
          return `# No Workflows Found\n\nNo .workflow.json files found${params.site ? ` for site "${params.site}"` : ''}.\n\nRecord workflows using \`/record <name> <site>\` in the CLI.`;
        }

        const lines = workflows.map(w => {
          let line = `- **${w.name}** (${w.id})\n  Site: ${w.site || 'any'} · ${w.workflow.steps.length} steps · Source: ${w.source}`;
          if (params.withVariables && w.workflow.variables?.length > 0) {
            const varList = w.workflow.variables.map(v =>
              `    - \`${v.name}\`${v.required ? ' (required)' : ''}: ${v.description || v.type || 'string'}${v.default !== undefined ? ` [default: ${v.default}]` : ''}`
            ).join('\n');
            line += `\n  Variables:\n${varList}`;
          } else if (w.workflow.variables?.length > 0) {
            line += ` · ${w.workflow.variables.length} variables`;
          }
          return line;
        });

        return `# Available Workflows (${workflows.length})\n\n${lines.join('\n\n')}\n\n_Use \`social_run_workflow\` to execute a workflow, optionally with post data mapped to variables._`;
      }
    );

    // social_run_workflow — execute a workflow with optional post data
    ctx.registerTool(
      {
        name: 'social_run_workflow',
        description: 'Execute a Woodbury workflow AUTONOMOUSLY via the Chrome bridge. The tool handles ALL browser automation internally (navigation, clicking, typing, waiting) — do NOT use any browser tools (browser_query, mouse, keyboard, etc.) before, during, or after calling this tool. Just call it and wait for the result. Optionally maps social scheduler post data to workflow variables. Can run standalone workflows or chain multiple in a pipeline.',
        dangerous: true,
        parameters: {
          type: 'object',
          properties: {
            workflowId: { type: 'string', description: 'ID of the workflow to run' },
            postId: { type: 'string', description: 'Optional: post ID to pull data from (auto-maps text, imagePath, videoPath, etc. to workflow variables)' },
            variables: {
              type: 'object',
              description: 'Explicit variable overrides (takes priority over auto-mapped post data)',
              additionalProperties: true,
            },
            pipeline: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  workflowId: { type: 'string' },
                  variables: { type: 'object', additionalProperties: true },
                },
                required: ['workflowId'],
              },
              description: 'For chaining: array of workflow steps to execute in sequence. Output variables from each step are passed to the next. If provided, workflowId is ignored.',
            },
          },
        }
      },
      async (params) => {
        // Check bridge connectivity
        if (!ctx.bridgeServer.isConnected) {
          return '# Error\n\nChrome extension is not connected. Connect the Woodbury Chrome extension before running workflows.';
        }

        // Build post data if postId provided
        let postData = {};
        if (params.postId) {
          const post = storage.getPost(env, params.postId);
          if (!post) {
            return `# Error\n\nPost not found: ${params.postId}`;
          }

          const mediaDir = storage.getMediaDir(env);
          const postMediaDir = path.join(mediaDir, post.id);
          const imagePaths = post.content.images.map(img => path.join(postMediaDir, img.filename));
          const platformText = post.content.text;
          const videoData = post.content.video;

          postData = {
            text: platformText,
            captionText: platformText,
            postText: platformText,
            imagePath: imagePaths.length > 0 ? imagePaths[0] : null,
            videoPath: videoData ? videoData.path : null,
            titleText: videoData?.title || platformText.slice(0, 100),
            postId: post.id,
            tags: post.tags || [],
            scheduledAt: post.scheduledAt,
          };
        }

        // Pipeline mode: chain multiple workflows
        if (params.pipeline && params.pipeline.length > 0) {
          const discovered = workflowRunner.discoverWorkflows(ctx.workingDirectory);

          const pipelineWorkflows = [];
          for (const step of params.pipeline) {
            const found = discovered.find(d => d.id === step.workflowId);
            if (!found) {
              return `# Error\n\nWorkflow not found in pipeline: "${step.workflowId}"`;
            }
            pipelineWorkflows.push({ workflow: found.workflow, variables: step.variables });
          }

          const mergedVars = { ...postData, ...(params.variables || {}) };

          const result = await workflowRunner.executePipeline(
            ctx.bridgeServer,
            pipelineWorkflows,
            mergedVars,
            { log: (msg) => ctx.log.info(`[workflow-pipeline] ${msg}`) }
          );

          if (result.success) {
            const steps = result.results.map((r, i) =>
              `${i + 1}. ${pipelineWorkflows[i].workflow.name} — ${r.stepsExecuted}/${r.stepsTotal} steps (${r.durationMs}ms)`
            ).join('\n');
            return `# Pipeline Complete\n\n${steps}\n\n**Total workflows:** ${result.results.length}\n**Output variables:** ${JSON.stringify(result.finalVariables, null, 2)}`;
          } else {
            return `# Pipeline Failed\n\n**Error:** ${result.error}\n\n**Results:**\n${result.results.map((r, i) =>
              `${i + 1}. ${pipelineWorkflows[i].workflow.name} — ${r.success ? 'OK' : 'FAILED: ' + r.error}`
            ).join('\n')}`;
          }
        }

        // Single workflow mode
        if (!params.workflowId) {
          return '# Error\n\nProvide either `workflowId` for a single workflow or `pipeline` for chaining.';
        }

        const discovered = workflowRunner.discoverWorkflows(ctx.workingDirectory);
        const found = discovered.find(d => d.id === params.workflowId);
        if (!found) {
          return `# Error\n\nWorkflow not found: "${params.workflowId}"\n\nUse \`social_list_workflows\` to see available workflows.`;
        }

        // Map post data to workflow variables
        const autoMapped = workflowRunner.mapPostToVariables(found.workflow, postData, params.variables);
        const allVars = { ...autoMapped, ...(params.variables || {}) };

        // Check coverage
        const coverage = workflowRunner.checkVariableCoverage(found.workflow, postData);
        let coverageNote = '';
        if (coverage.missing.length > 0 && !params.variables) {
          coverageNote = `\n\n**Warning:** Missing required variables: ${coverage.missing.join(', ')}\nProvide them via the \`variables\` parameter.`;
        }

        // Execute
        const result = await workflowRunner.executeWorkflow(
          ctx.bridgeServer,
          found.workflow,
          allVars,
          { log: (msg) => ctx.log.info(`[workflow] ${msg}`) }
        );

        if (result.success) {
          let summary = `# Workflow Complete: ${found.workflow.name}\n\n`;
          summary += `- **Steps:** ${result.stepsExecuted}/${result.stepsTotal}\n`;
          summary += `- **Duration:** ${result.durationMs}ms\n`;
          if (Object.keys(result.variables).length > 0) {
            summary += `- **Output variables:** ${JSON.stringify(result.variables, null, 2)}\n`;
          }
          return summary;
        } else {
          return `# Workflow Failed: ${found.workflow.name}\n\n**Error:** ${result.error}\n- **Steps completed:** ${result.stepsExecuted}/${result.stepsTotal}\n- **Duration:** ${result.durationMs}ms${coverageNote}`;
        }
      }
    );

    // social_check_workflow — check variable compatibility between post and workflow
    ctx.registerTool(
      {
        name: 'social_check_workflow',
        description: 'Check if a workflow is compatible with a social scheduler post. Shows which workflow variables would be auto-filled from post data and which are missing.',
        parameters: {
          type: 'object',
          properties: {
            workflowId: { type: 'string', description: 'Workflow ID to check' },
            postId: { type: 'string', description: 'Post ID to check against' },
          },
          required: ['workflowId']
        }
      },
      async (params) => {
        const discovered = workflowRunner.discoverWorkflows(ctx.workingDirectory);
        const found = discovered.find(d => d.id === params.workflowId);
        if (!found) {
          return `# Error\n\nWorkflow not found: "${params.workflowId}"`;
        }

        let postData = {};
        if (params.postId) {
          const post = storage.getPost(env, params.postId);
          if (!post) {
            return `# Error\n\nPost not found: ${params.postId}`;
          }
          const mediaDir = storage.getMediaDir(env);
          const postMediaDir = path.join(mediaDir, post.id);
          const imagePaths = post.content.images.map(img => path.join(postMediaDir, img.filename));
          postData = {
            text: post.content.text,
            captionText: post.content.text,
            postText: post.content.text,
            imagePath: imagePaths.length > 0 ? imagePaths[0] : null,
            videoPath: post.content.video?.path || null,
            titleText: post.content.video?.title || post.content.text.slice(0, 100),
            postId: post.id,
          };
        }

        const coverage = workflowRunner.checkVariableCoverage(found.workflow, postData);
        const mapped = workflowRunner.mapPostToVariables(found.workflow, postData);

        let result = `# Workflow Compatibility: ${found.workflow.name}\n\n`;

        if (coverage.satisfied.length > 0) {
          result += `**Auto-mapped (${coverage.satisfied.length}):**\n`;
          result += coverage.satisfied.map(v => `  - \`${v}\` → ${JSON.stringify(mapped[v]).slice(0, 60)}`).join('\n');
          result += '\n\n';
        }

        if (coverage.missing.length > 0) {
          result += `**Missing required (${coverage.missing.length}):**\n`;
          result += coverage.missing.map(v => `  - \`${v}\` — needs explicit value`).join('\n');
          result += '\n\n';
        }

        if (coverage.optional.length > 0) {
          result += `**Optional unset (${coverage.optional.length}):**\n`;
          result += coverage.optional.map(v => `  - \`${v}\``).join('\n');
          result += '\n\n';
        }

        const isReady = coverage.missing.length === 0;
        result += isReady
          ? `**Status:** Ready to run with \`social_run_workflow\``
          : `**Status:** Cannot run — provide missing variables via the \`variables\` parameter`;

        return result;
      }
    );

    // ─── Slash Command ───────────────────────────────────────────────
    ctx.registerCommand({
      name: 'social',
      description: 'Social media scheduler commands: status, today, platforms, post, dashboard, workflows',
      handler: async (args, cmdCtx) => {
        const subcommand = args[0] || 'status';

        switch (subcommand) {
          case 'status': {
            const counts = storage.getStatusCounts(env);
            cmdCtx.print(`\n📊 Social Scheduler Status`);
            cmdCtx.print(`  Drafts:    ${counts.draft}`);
            cmdCtx.print(`  Scheduled: ${counts.scheduled}`);
            cmdCtx.print(`  Posting:   ${counts.posting}`);
            cmdCtx.print(`  Posted:    ${counts.posted}`);
            cmdCtx.print(`  Failed:    ${counts.failed}`);
            cmdCtx.print(`  Total:     ${counts.total}`);
            if (webAppProcess) {
              cmdCtx.print(`\n  🌐 Web app running at ${webAppUrl}`);
            }
            break;
          }

          case 'today': {
            const posts = storage.getTodayPosts(env);
            if (posts.length === 0) {
              cmdCtx.print('\n📅 No posts scheduled for today.');
            } else {
              cmdCtx.print(`\n📅 Today's Posts (${posts.length}):`);
              for (const p of posts) {
                const platforms = p.platforms.filter(pt => pt.enabled).map(pt => pt.platform).join(', ');
                const time = p.scheduledAt ? new Date(p.scheduledAt).toLocaleTimeString() : 'Unscheduled';
                cmdCtx.print(`  [${p.status}] ${time} → ${platforms}: "${p.content.text.slice(0, 50)}..."`);
              }
            }
            break;
          }

          case 'platforms': {
            const connectors = storage.listConnectors(env);
            if (connectors.length === 0) {
              cmdCtx.print('\n📱 No platform connectors configured.');
              cmdCtx.print('  Add connector JSON files to ~/.woodbury/social-scheduler/connectors/');
            } else {
              cmdCtx.print(`\n📱 Platform Connectors (${connectors.length}):`);
              for (const c of connectors) {
                cmdCtx.print(`  ${c.displayName || c.platform} — ${c.baseUrl}`);
              }
            }
            break;
          }

          case 'post': {
            const postId = args[1];
            if (!postId) {
              cmdCtx.print('\n Usage: /social post <post-id>');
              break;
            }
            cmdCtx.print(`\n🚀 Use the agent to post: "post ${postId} to all platforms"`);
            break;
          }

          case 'post-all': {
            const due = storage.getDuePosts(env);
            if (due.length === 0) {
              cmdCtx.print('\n No posts are due right now.');
            } else {
              cmdCtx.print(`\n🚀 ${due.length} post(s) due. Tell the agent: "post the scheduled items"`);
            }
            break;
          }

          case 'dashboard': {
            const url = webAppUrl;
            if (webAppProcess) {
              cmdCtx.print(`\n🌐 Scheduler Dashboard (running): ${url}`);
            } else {
              cmdCtx.print(`\n🌐 Scheduler Dashboard: ${url}`);
              cmdCtx.print('  ⚠️  Web app is not running. Start it manually or restart Woodbury.');
            }
            break;
          }

          case 'workflows': {
            const workflows = workflowRunner.discoverWorkflows(ctx.workingDirectory);
            if (workflows.length === 0) {
              cmdCtx.print('\n🔄 No workflows available.');
              cmdCtx.print('  Record one using /record <name> <site>');
            } else {
              cmdCtx.print(`\n🔄 Available Workflows (${workflows.length}):`);
              for (const w of workflows) {
                const vars = w.workflow.variables?.length || 0;
                const steps = w.workflow.steps.length;
                cmdCtx.print(`  ${w.name} — ${w.site || 'any'} · ${steps} steps · ${vars} vars · [${w.source}]`);
              }
            }
            break;
          }

          default:
            cmdCtx.print(`\n Unknown subcommand: ${subcommand}`);
            cmdCtx.print('  Available: status, today, platforms, post <id>, post-all, dashboard, workflows');
        }
      }
    });

    // ─── Background Task: Check for due posts ────────────────────────
    ctx.registerBackgroundTask(
      () => {
        const duePosts = storage.getDuePosts(env);
        if (duePosts.length === 0) return null;

        const postList = duePosts.map(p => {
          const platforms = p.platforms
            .filter(pt => pt.enabled && pt.status === 'pending')
            .map(pt => pt.platform)
            .join(', ');
          return `- Post ${p.id.slice(0, 8)}: "${p.content.text.slice(0, 60)}..." → ${platforms}`;
        }).join('\n');

        return `There are ${duePosts.length} scheduled post(s) that are now due for posting:\n\n${postList}\n\nPlease post them now. For each post, use \`social_post_now\` with the post ID and each platform. Post them one at a time.`;
      },
      {
        intervalMs: 60000,
        label: 'Due post check',
        runImmediately: true,
      }
    );

    ctx.log.info('Social Scheduler extension activated');
  },

  async deactivate() {
    // Shut down the Next.js dev server if we started it
    if (webAppProcess) {
      try {
        // Destroy pipe streams so they don't hold the event loop open
        if (webAppProcess.stdout) webAppProcess.stdout.destroy();
        if (webAppProcess.stderr) webAppProcess.stderr.destroy();
        webAppProcess.kill('SIGTERM');
      } catch {
        // Already dead
      }
      webAppProcess = null;
    }

    // Clean up status file
    try {
      const statusFile = path.join(__dirname, '.webui-status.json');
      if (fs.existsSync(statusFile)) {
        fs.unlinkSync(statusFile);
      }
    } catch {
      // Non-critical
    }
  }
};

/**
 * Load site-knowledge markdown files for system prompt injection.
 */
function loadSiteKnowledge(siteKnowledgeDir) {
  if (!fs.existsSync(siteKnowledgeDir)) return '';

  const platforms = fs.readdirSync(siteKnowledgeDir)
    .filter(d => !d.startsWith('_') && fs.statSync(path.join(siteKnowledgeDir, d)).isDirectory());

  if (platforms.length === 0) return '';

  const sections = platforms.map(platform => {
    const dir = path.join(siteKnowledgeDir, platform);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    const content = files.map(f => {
      const text = fs.readFileSync(path.join(dir, f), 'utf-8');
      return `#### ${f.replace('.md', '')}\n${text}`;
    }).join('\n\n');
    return `### Platform: ${platform}\n${content}`;
  });

  return `### Platform Site Knowledge\n\n${sections.join('\n\n')}`;
}
