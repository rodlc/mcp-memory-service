#!/usr/bin/env node
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve({}), 200);
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    process.stdin.resume();
  });
}

function formatCacheAge(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function semverCompare(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function worktreeContext(cwd) {
  try {
    const git = (c) => execSync(c, { encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    const gitDir = git('git rev-parse --git-dir');
    const gitCommonDir = git('git rev-parse --git-common-dir');
    const repoName = path.dirname(path.resolve(cwd, gitCommonDir)).split('/').pop();

    const branch = git('git symbolic-ref --short HEAD');
    if (gitDir === gitCommonDir) {
      if (['workspace', 'dotfiles'].includes(repoName)) return null;
      return `⚠ NOT in a worktree on ${repoName} (branch: ${branch}). Call EnterWorktree before any edits.`;
    }
    const wtName = git('git rev-parse --show-toplevel').split('/').pop();
    if (branch.startsWith('worktree-')) {
      return `📍 Worktree '${wtName}' on ${repoName} — landing branch (branch: ${branch}). Create a task branch: git checkout -b feat-xxx`;
    }
    let merged = false;
    try { merged = git(`git for-each-ref --format="%(upstream:track)" "refs/heads/${branch}"`) === '[gone]'; } catch {}
    if (merged) {
      return `📍 Worktree '${wtName}' on ${repoName} — branch merged (branch: ${branch}). Create a new task branch: git checkout -b feat-xxx`;
    }
    const lastCommit = git('git log -1 --format="%cr"');
    let portInfo = '';
    try { portInfo = `, port: ${fs.readFileSync(path.join(cwd, '.port'), 'utf8').trim()}`; } catch {}
    return `📍 Worktree '${wtName}' on ${repoName} (branch: ${branch}, last commit: ${lastCommit}${portInfo}). New task? → EnterWorktree.`;
  } catch { return null; }
}

function planCacheHealth() {
  const DB = path.join(process.env.HOME, '.claude/plan-cache.db');
  const BACKUP_DIR = path.join(process.env.HOME, 'Library/Mobile Documents/com~apple~CloudDocs/Backup/MCP_Memory/plan-cache');
  const BACKUP_MAX_AGE_H = 48;
  const WAL_RATIO_WARN = 70;

  if (!fs.existsSync(DB)) return '⚠️ plan-cache.db not found';

  let rowCount;
  try {
    rowCount = execSync(`sqlite3 "${DB}" "SELECT count(*) FROM plans;"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  } catch { return '⚠️ plan-cache.db unreadable (corrupt or locked)'; }

  const warnings = [];
  try {
    const dbSize = fs.statSync(DB).size;
    const wal = `${DB}-wal`;
    if (dbSize > 0 && fs.existsSync(wal)) {
      const walPct = Math.floor((fs.statSync(wal).size * 100) / dbSize);
      if (walPct >= WAL_RATIO_WARN) warnings.push(`WAL ${walPct}% (checkpoint needed)`);
    }
  } catch {}

  try {
    if (fs.existsSync(BACKUP_DIR)) {
      const backups = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db'))
        .map((f) => ({ f, m: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      if (backups.length) {
        const ageH = Math.floor((Date.now() - backups[0].m) / 3600000);
        if (ageH >= BACKUP_MAX_AGE_H) warnings.push(`backup ${ageH}h old (>${BACKUP_MAX_AGE_H}h)`);
      } else warnings.push('no backup found');
    } else warnings.push('backup dir missing');
  } catch {}

  return warnings.length
    ? `⚠️ plan-cache: ${rowCount} plans — ${warnings.join(', ')}`
    : `📋 plan-cache: ${rowCount} plans`;
}

function claudeVersion() {
  let current;
  try {
    const raw = execSync('claude --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    current = raw.split(/\s+/)[0];
  } catch { return null; }
  if (!current) return null;

  const MIN_VERSION = '2.1.90';
  if (semverCompare(current, MIN_VERSION) < 0) {
    return `🛡️ Claude Code v${current} < v${MIN_VERSION} (CVE-2025-54794) ⇒ claude update`;
  }

  const cacheFile = path.join(process.env.HOME, '.cache/cc-latest-version');
  let latest = null;
  let cacheAge = Infinity;

  try {
    const stat = fs.statSync(cacheFile);
    cacheAge = Date.now() - stat.mtimeMs;
    if (cacheAge < 86400000) {
      latest = fs.readFileSync(cacheFile, 'utf8').trim();
    }
  } catch {}

  if (cacheAge >= 86400000) {
    const child = spawn('sh', ['-c', `npm view @anthropic-ai/claude-code version > "${cacheFile}" 2>/dev/null`], {
      detached: true, stdio: 'ignore',
    });
    child.unref();
    if (!latest) {
      try { latest = fs.readFileSync(cacheFile, 'utf8').trim(); } catch {}
    }
  }

  if (latest && semverCompare(current, latest) < 0) {
    let claudeBin;
    try { claudeBin = execSync('which claude', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim(); } catch {}
    const updateCmd = claudeBin && claudeBin.includes('/mise/') ? 'mise upgrade claude-code' : 'claude update';
    const age = cacheAge < 86400000 ? ` [${formatCacheAge(cacheAge)}]` : '';
    return `🤖 Claude Code v${current} → v${latest} ⇒ ${updateCmd}${age}`;
  }

  return null;
}

function scheduledAgents() {
  const cacheFile = path.join(process.env.HOME, '.cache/claude-jobs');
  try {
    const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const age = Date.now() - fs.statSync(cacheFile).mtimeMs;

    if (data.failed_ids) {
      if (data.failed_count === 0) return null;
      return `🦾 Claude Jobs ${data.failed_count} failed (${data.failed_ids.join(', ')}) ⇒ claude-jobs [${formatCacheAge(age)}]`;
    }

    const { failed = 0 } = data;
    if (failed === 0) return null;
    return `🦾 Claude Jobs ${failed} failed ⇒ claude-jobs [${formatCacheAge(age)}]`;
  } catch { return null; }
}

function driftCheck() {
  const cacheFile = path.join(process.env.HOME, '.cache/claude-drift');
  try {
    const content = fs.readFileSync(cacheFile, 'utf8').trim();
    if (!content) return null;
    const age = Date.now() - fs.statSync(cacheFile).mtimeMs;
    return `${content} [${formatCacheAge(age)}]`;
  } catch { return null; }
}

async function main() {
  const input = await readStdin();
  const cwd = input.cwd || process.cwd();

  const parts = [
    worktreeContext(cwd),
    planCacheHealth(),
    claudeVersion(),
    scheduledAgents(),
    driftCheck(),
  ].filter(Boolean);
  if (parts.length) {
    process.stdout.write(JSON.stringify({ systemMessage: parts.join('\n') }));
  }
  process.exit(0);
}

main().catch(() => process.exit(0));
