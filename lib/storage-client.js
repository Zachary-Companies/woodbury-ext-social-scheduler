/**
 * Storage client for the social scheduler.
 * Reads/writes post JSON files from ~/.woodbury/social-scheduler/posts/
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.woodbury', 'social-scheduler');

function getDataDir(env) {
  return env?.SOCIAL_SCHEDULER_DATA_DIR || DEFAULT_DATA_DIR;
}

function getPostsDir(env) {
  return path.join(getDataDir(env), 'posts');
}

function getMediaDir(env) {
  return path.join(getDataDir(env), 'media');
}

function getConfigPath(env) {
  return path.join(getDataDir(env), 'config.json');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * List all posts, optionally filtered.
 */
function listPosts(env, filters = {}) {
  const postsDir = getPostsDir(env);
  ensureDir(postsDir);

  const files = fs.readdirSync(postsDir).filter(f => f.endsWith('.json'));
  let posts = files.map(f => {
    try {
      return JSON.parse(fs.readFileSync(path.join(postsDir, f), 'utf-8'));
    } catch {
      return null;
    }
  }).filter(Boolean);

  // Apply filters
  if (filters.status) {
    posts = posts.filter(p => p.status === filters.status);
  }
  if (filters.platform) {
    posts = posts.filter(p =>
      p.platforms.some(pt => pt.platform === filters.platform && pt.enabled)
    );
  }
  if (filters.from) {
    const from = new Date(filters.from);
    posts = posts.filter(p => p.scheduledAt && new Date(p.scheduledAt) >= from);
  }
  if (filters.to) {
    const to = new Date(filters.to);
    posts = posts.filter(p => p.scheduledAt && new Date(p.scheduledAt) <= to);
  }
  if (filters.tag) {
    posts = posts.filter(p => p.tags.includes(filters.tag));
  }

  // Sort by scheduledAt (earliest first), drafts last
  posts.sort((a, b) => {
    if (!a.scheduledAt && !b.scheduledAt) return 0;
    if (!a.scheduledAt) return 1;
    if (!b.scheduledAt) return -1;
    return new Date(a.scheduledAt) - new Date(b.scheduledAt);
  });

  return posts;
}

/**
 * Get a single post by ID.
 */
function getPost(env, id) {
  const filePath = path.join(getPostsDir(env), `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Create a new post.
 */
function createPost(env, data) {
  const postsDir = getPostsDir(env);
  ensureDir(postsDir);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const post = {
    id,
    createdAt: now,
    updatedAt: now,
    content: {
      text: data.text || '',
      images: data.images || [],
      video: data.video || null,
      platformOverrides: data.platformOverrides || {}
    },
    scheduledAt: data.scheduledAt || null,
    timezone: data.timezone || 'America/New_York',
    platforms: (data.platforms || []).map(p => ({
      platform: typeof p === 'string' ? p : p.platform,
      enabled: true,
      status: 'pending',
      retryCount: 0
    })),
    status: data.scheduledAt ? 'scheduled' : 'draft',
    tags: data.tags || [],
    generation: data.generation || undefined
  };

  // Create media directory for this post
  const mediaDir = path.join(getMediaDir(env), id);
  ensureDir(mediaDir);

  fs.writeFileSync(path.join(postsDir, `${id}.json`), JSON.stringify(post, null, 2));
  return post;
}

/**
 * Update an existing post.
 */
function updatePost(env, id, data) {
  const filePath = path.join(getPostsDir(env), `${id}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Post not found: ${id}`);
  }

  const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const updated = {
    ...existing,
    ...data,
    id, // prevent ID changes
    updatedAt: new Date().toISOString(),
    content: data.content ? { ...existing.content, ...data.content } : existing.content,
  };

  // Auto-update status based on scheduledAt
  if (data.scheduledAt !== undefined && updated.status === 'draft') {
    updated.status = data.scheduledAt ? 'scheduled' : 'draft';
  }

  fs.writeFileSync(filePath, JSON.stringify(updated, null, 2));
  return updated;
}

/**
 * Delete a post and its media.
 */
function deletePost(env, id) {
  const postPath = path.join(getPostsDir(env), `${id}.json`);
  const mediaPath = path.join(getMediaDir(env), id);

  if (fs.existsSync(postPath)) {
    fs.unlinkSync(postPath);
  }
  if (fs.existsSync(mediaPath)) {
    fs.rmSync(mediaPath, { recursive: true, force: true });
  }
}

/**
 * Get posts that are due for posting (scheduledAt <= now, status === 'scheduled').
 */
function getDuePosts(env, until) {
  const cutoff = until ? new Date(until) : new Date();
  return listPosts(env, { status: 'scheduled' }).filter(p =>
    p.scheduledAt && new Date(p.scheduledAt) <= cutoff
  );
}

/**
 * Get post counts by status.
 */
function getStatusCounts(env) {
  const posts = listPosts(env);
  const counts = { draft: 0, scheduled: 0, posting: 0, posted: 0, partial: 0, failed: 0, total: posts.length };
  for (const post of posts) {
    if (counts[post.status] !== undefined) {
      counts[post.status]++;
    }
  }
  return counts;
}

/**
 * Get today's posts.
 */
function getTodayPosts(env) {
  const today = new Date();
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
  const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).toISOString();
  return listPosts(env, { from: startOfDay, to: endOfDay });
}

/**
 * Read the scheduler config.
 */
function getConfig(env) {
  const configPath = getConfigPath(env);
  if (!fs.existsSync(configPath)) {
    return {
      defaultTimezone: 'America/New_York',
      defaultPlatforms: [],
      llm: { textProvider: 'anthropic', textModel: 'claude-opus-4-5-20251101' },
      posting: { delayBetweenPlatforms: 5000, retryLimit: 2, retryDelay: 10000 }
    };
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

/**
 * List available platform connectors.
 */
function listConnectors(env) {
  const connectorsDir = path.join(getDataDir(env), 'connectors');
  ensureDir(connectorsDir);
  const files = fs.readdirSync(connectorsDir).filter(f => f.endsWith('.json'));
  return files.map(f => {
    try {
      return JSON.parse(fs.readFileSync(path.join(connectorsDir, f), 'utf-8'));
    } catch {
      return null;
    }
  }).filter(Boolean);
}

// ── Posting Session Persistence ──────────────────────────────────

function getSessionsDir(env) {
  return path.join(getDataDir(env), 'posting-sessions');
}

/**
 * Save a posting session (engine state) to disk.
 */
function savePostingSession(env, sessionId, data) {
  const dir = getSessionsDir(env);
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify(data, null, 2));
}

/**
 * Load a posting session from disk. Returns null if missing or expired.
 * @param {number} [maxAgeMs=600000] - Maximum age in ms (default: 10 minutes)
 */
function loadPostingSession(env, sessionId, maxAgeMs = 600000) {
  const filePath = path.join(getSessionsDir(env), `${sessionId}.json`);
  if (!fs.existsSync(filePath)) return null;

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    // Check expiry
    const updatedAt = new Date(data.updatedAt || data.createdAt);
    if (Date.now() - updatedAt.getTime() > maxAgeMs) {
      // Expired — clean up
      try { fs.unlinkSync(filePath); } catch {}
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * Delete a posting session from disk.
 */
function deletePostingSession(env, sessionId) {
  const filePath = path.join(getSessionsDir(env), `${sessionId}.json`);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Non-critical
  }
}

/**
 * Clean up expired posting sessions.
 */
function cleanExpiredSessions(env, maxAgeMs = 600000) {
  const dir = getSessionsDir(env);
  if (!fs.existsSync(dir)) return;

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  for (const f of files) {
    try {
      const filePath = path.join(dir, f);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const updatedAt = new Date(data.updatedAt || data.createdAt);
      if (Date.now() - updatedAt.getTime() > maxAgeMs) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Skip unreadable files
    }
  }
}

module.exports = {
  listPosts,
  getPost,
  createPost,
  updatePost,
  deletePost,
  getDuePosts,
  getStatusCounts,
  getTodayPosts,
  getConfig,
  listConnectors,
  getDataDir,
  getPostsDir,
  getMediaDir,
  ensureDir,
  savePostingSession,
  loadPostingSession,
  deletePostingSession,
  cleanExpiredSessions,
  getSessionsDir,
};
