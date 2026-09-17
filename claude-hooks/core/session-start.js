#!/usr/bin/env node
/**
 * SessionStart hook — emits worktree context + plan-cache health as a systemMessage.
 * systemMessage is top-level (reaches both model and user); additionalContext (nested)
 * would reach the model only. Plain stdout would be silently dropped for structured needs.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve({}), 1500);
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    process.stdin.resume();
  });
}

function worktreeContext(cwd) {
  try {
    const git = (c) => execSync(c, { encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    const gitDir = git('git rev-parse --git-dir');
    const gitCommonDir = git('git rev-parse --git-common-dir');
    const repoName = path.dirname(path.resolve(cwd, gitCommonDir)).split('/').pop();
    if (['workspace', 'dotfiles'].includes(repoName)) return null;

    const branch = git('git symbolic-ref --short HEAD');
    if (gitDir === gitCommonDir) {
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

  if (!fs.existsSync(DB)) return '⚠ plan-cache.db not found';

  let rowCount;
  try {
    rowCount = execSync(`sqlite3 "${DB}" "SELECT count(*) FROM plans;"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  } catch { return '⚠ plan-cache.db unreadable (corrupt or locked)'; }

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
    ? `⚠ plan-cache: ${rowCount} plans — ${warnings.join(', ')}`
    : `✓ plan-cache: ${rowCount} plans`;
}

async function main() {
  const input = await readStdin();
  const cwd = input.cwd || process.cwd();

  const parts = [worktreeContext(cwd), planCacheHealth()].filter(Boolean);
  if (parts.length) {
    process.stdout.write(JSON.stringify({ systemMessage: parts.join('\n') }));
  }
  process.exit(0);
}

main().catch(() => process.exit(0));
