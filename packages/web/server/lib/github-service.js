import { execFile } from 'child_process';
import { promisify } from 'util';
import simpleGit from 'simple-git';
import path from 'path';
import os from 'os';

const execFileAsync = promisify(execFile);

const normalizeDirectoryPath = (value) => {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (trimmed === '~') {
    return os.homedir();
  }

  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }

  return trimmed;
};

/**
 * Run gh CLI command and return output
 */
async function runGhCommand(args, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync('gh', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    return { stdout: stdout.trim(), stderr: stderr?.trim() || '' };
  } catch (error) {
    // Check if gh CLI is not installed or not authenticated
    const message = error.message || error.stderr || '';
    if (message.includes('not found') || message.includes('ENOENT')) {
      throw new Error('GitHub CLI (gh) is not installed. Please install it from https://cli.github.com/');
    }
    if (message.includes('not logged in') || message.includes('authentication')) {
      throw new Error('Not authenticated with GitHub. Please run: gh auth login');
    }
    throw error;
  }
}

/**
 * Parse owner/repo from a GitHub PR URL
 * This is more reliable than parsing from origin remote when working on forks
 */
function parseRepoFromPRUrl(prUrl) {
  if (!prUrl) return null;

  // Match URLs like https://github.com/owner/repo/pull/123
  const match = prUrl.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull/);
  if (!match) return null;

  return {
    owner: match[1],
    repo: match[2],
  };
}

/**
 * Check if directory is a GitHub repository
 */
async function isGitHubRepo(directory) {
  const git = simpleGit(normalizeDirectoryPath(directory));

  try {
    const remotes = await git.getRemotes(true);
    const hasGitHubRemote = remotes.some(r => {
      const url = r.refs?.fetch || '';
      return url.includes('github.com');
    });
    return hasGitHubRemote;
  } catch (error) {
    console.error('Failed to check GitHub repo:', error);
    return false;
  }
}

/**
 * Get current branch name
 */
async function getCurrentBranch(directory) {
  const git = simpleGit(normalizeDirectoryPath(directory));
  const status = await git.status();
  return status.current;
}

/**
 * Get PR information for the current branch
 */
export async function getPRForBranch(directory) {
  const directoryPath = normalizeDirectoryPath(directory);

  // Check if it's a GitHub repository
  const isGitHub = await isGitHubRepo(directory);
  if (!isGitHub) {
    return { hasPR: false, error: 'Not a GitHub repository' };
  }

  const currentBranch = await getCurrentBranch(directory);
  if (!currentBranch) {
    return { hasPR: false, error: 'Could not determine current branch' };
  }

  try {
    // Get PR info using gh CLI
    const { stdout } = await runGhCommand([
      'pr', 'view',
      '--json', 'number,title,state,url,isDraft,mergeable,mergeStateStatus,headRefName,baseRefName,statusCheckRollup,comments,reviews',
      '--jq', '.'
    ], directoryPath);

    if (!stdout) {
      return { hasPR: false };
    }

    const prData = JSON.parse(stdout);

    // Extract owner/repo from PR URL (works correctly with forks)
    const repoInfo = parseRepoFromPRUrl(prData.url);

    // Get check runs separately for more detail
    let checks = [];
    try {
      const { stdout: checksStdout } = await runGhCommand([
        'pr', 'checks',
        '--json', 'name,state,conclusion,detailsUrl'
      ], directoryPath);

      if (checksStdout) {
        checks = JSON.parse(checksStdout);
      }
    } catch (e) {
      // Checks might not be available
      console.warn('Could not fetch PR checks:', e.message);
    }

    // Calculate check status
    const checksStatus = {
      total: checks.length,
      passed: checks.filter(c => c.conclusion === 'success' || c.conclusion === 'SUCCESS').length,
      failed: checks.filter(c => c.conclusion === 'failure' || c.conclusion === 'FAILURE').length,
      pending: checks.filter(c => !c.conclusion || c.state === 'pending' || c.state === 'PENDING').length,
    };

    // Transform checks to our format
    const transformedChecks = checks.map(check => ({
      id: 0, // gh CLI doesn't provide ID
      name: check.name,
      status: check.state === 'pending' ? 'in_progress' : 'completed',
      conclusion: (check.conclusion || 'pending').toLowerCase(),
      url: check.detailsUrl || '',
      detailsUrl: check.detailsUrl,
    }));

    // Get review comments (only if we have repo info from PR URL)
    let reviewComments = [];
    if (repoInfo) {
      try {
        const { stdout: reviewsStdout } = await runGhCommand([
          'api',
          `repos/${repoInfo.owner}/${repoInfo.repo}/pulls/${prData.number}/comments`,
          '--jq', '.[] | {id, body, user: {login: .user.login}, createdAt: .created_at, updatedAt: .updated_at, path, line: .line, diffHunk: .diff_hunk}'
        ], directoryPath);

        if (reviewsStdout) {
          const lines = reviewsStdout.split('\n').filter(Boolean);
          reviewComments = lines.map(line => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          }).filter(Boolean);
        }
      } catch (e) {
        console.warn('Could not fetch review comments:', e.message);
      }
    }

    // Transform comments
    const comments = (prData.comments || []).map(comment => ({
      id: comment.id || 0,
      body: comment.body || '',
      user: {
        login: comment.author?.login || 'unknown',
        avatarUrl: comment.author?.avatarUrl,
      },
      createdAt: comment.createdAt || '',
      updatedAt: comment.updatedAt || comment.createdAt || '',
    }));

    // Map merge state status
    const mergeableStateMap = {
      'CLEAN': 'clean',
      'DIRTY': 'dirty',
      'UNSTABLE': 'unstable',
      'BLOCKED': 'blocked',
      'BEHIND': 'behind',
    };

    const prInfo = {
      number: prData.number,
      title: prData.title,
      state: prData.state.toLowerCase(),
      url: prData.url,
      htmlUrl: prData.url,
      draft: prData.isDraft || false,
      mergeable: prData.mergeable === 'MERGEABLE',
      mergeableState: mergeableStateMap[prData.mergeStateStatus] || 'unknown',
      headRef: prData.headRefName,
      baseRef: prData.baseRefName,
      checksStatus,
      checks: transformedChecks,
      comments,
      reviewComments,
    };

    return { hasPR: true, pr: prInfo };
  } catch (error) {
    // Handle "no pull requests found" gracefully
    if (error.message?.includes('no pull requests found') ||
        error.stderr?.includes('no pull requests found')) {
      return { hasPR: false };
    }

    console.error('Failed to get PR info:', error);
    return { hasPR: false, error: error.message || 'Failed to get PR info' };
  }
}

/**
 * Create a new PR
 */
export async function createPR(directory, payload) {
  const directoryPath = normalizeDirectoryPath(directory);

  try {
    const args = [
      'pr', 'create',
      '--title', payload.title,
      '--body', payload.body || '',
      '--base', payload.base,
      '--head', payload.head,
    ];

    if (payload.draft) {
      args.push('--draft');
    }

    const { stdout } = await runGhCommand(args, directoryPath);

    // gh pr create returns the PR URL
    const prUrl = stdout.trim();

    // Fetch the full PR info
    const prResult = await getPRForBranch(directory);

    return {
      success: true,
      pr: prResult.pr,
    };
  } catch (error) {
    console.error('Failed to create PR:', error);
    return {
      success: false,
      error: error.message || 'Failed to create PR',
    };
  }
}

/**
 * Merge a PR
 * @param {string} directory - The directory path
 * @param {object} options - Merge options
 * @param {string} options.strategy - Merge strategy: 'merge' | 'squash' | 'rebase'
 */
export async function mergePR(directory, options = {}) {
  const directoryPath = normalizeDirectoryPath(directory);
  const strategy = options.strategy || 'merge';

  try {
    const args = ['pr', 'merge', '--delete-branch=false'];

    // Add strategy flag
    switch (strategy) {
      case 'squash':
        args.push('--squash');
        break;
      case 'rebase':
        args.push('--rebase');
        break;
      case 'merge':
      default:
        args.push('--merge');
        break;
    }

    await runGhCommand(args, directoryPath);

    return {
      success: true,
      merged: true,
      message: `PR merged successfully using ${strategy} strategy`,
    };
  } catch (error) {
    console.error('Failed to merge PR:', error);
    return {
      success: false,
      merged: false,
      error: error.message || 'Failed to merge PR',
    };
  }
}

/**
 * Refresh PR checks (re-fetch check status)
 */
export async function refreshPRChecks(directory) {
  // This just re-fetches the PR info which includes checks
  return getPRForBranch(directory);
}
