'use strict';

async function repoInfo(rest, repository) {
  const r = await rest('GET', `/repos/${repository}`);
  if (r.status !== 200) throw new Error(`reading repository ${repository}: HTTP ${r.status}: ${r.text}`);
  return {
    visibility: r.json.visibility || (r.json.private ? 'private' : 'public'),
    defaultBranch: r.json.default_branch,
    ownerType: r.json.owner && r.json.owner.type,
  };
}

async function packageVisibility(rest, { ownerType, owner, packageName }) {
  const scope = ownerType === 'Organization' ? `orgs/${owner}` : `users/${owner}`;
  const r = await rest('GET', `/${scope}/packages/container/${encodeURIComponent(packageName)}`);
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(`reading package ${packageName}: HTTP ${r.status}: ${r.text}`);
  return r.json.visibility;
}

// This job, found by runner name among the run attempt's jobs that are not
// completed (hosted runner names repeat within a run). The jobs API can lag
// the job's start, so lookups are retried with backoff for up to `timeoutMs`.
async function findSelfJob(rest, env, { timeoutMs = 60_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const { GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run, GITHUB_RUN_ATTEMPT: attempt, RUNNER_NAME: runner } = env;
  let last = 'not listed yet';
  for (let waited = 0, delay = 1000; ; waited += delay, delay = Math.min(delay * 2, 8000)) {
    const found = await listForRunner();
    if (found) return found;
    if (waited + delay > timeoutMs) break;
    await sleep(delay);
  }
  throw new Error(`could not find this job (runner "${runner}") in run ${run} attempt ${attempt} within ${timeoutMs / 1000} s: ${last}`);

  async function listForRunner() {
    for (let page = 1; ; page += 1) {
      const r = await rest('GET', `/repos/${repo}/actions/runs/${run}/attempts/${attempt}/jobs?per_page=100&page=${page}`);
      if (r.status === 429 || r.status >= 500) {
        last = `HTTP ${r.status}`;
        return null;
      }
      if (r.status !== 200) throw new Error(`listing this run's jobs: HTTP ${r.status}: ${r.text}`);
      const jobs = r.json.jobs || [];
      const job = jobs.find((j) => j.runner_name === runner && j.status !== 'completed');
      if (job) return { id: job.id, name: job.name, url: job.html_url };
      if (jobs.length < 100) {
        last = 'not listed yet';
        return null;
      }
    }
  }
}

// The pull request this run is for: its number and head commit.
function pullRequestOf(env, readFile = (f) => require('fs').readFileSync(f, 'utf8')) {
  if (!['pull_request', 'pull_request_target'].includes(env.GITHUB_EVENT_NAME) || !env.GITHUB_EVENT_PATH) return null;
  let event;
  try { event = JSON.parse(readFile(env.GITHUB_EVENT_PATH)); } catch { return null; }
  const pr = event && event.pull_request;
  if (!pr || !Number.isInteger(pr.number)) return null;
  return { number: pr.number, headSha: (pr.head && pr.head.sha) || '' };
}

// Edits the pull request's comment that starts with `marker`, or adds one.
// Without `create`, a missing comment is left missing. A token that may not
// write comments (no pull-requests: write, or a fork's) is `forbidden`.
async function upsertComment(rest, { repository, number, marker, body, create = true }) {
  let found = null;
  for (let page = 1; !found; page += 1) {
    const r = await rest('GET', `/repos/${repository}/issues/${number}/comments?per_page=100&page=${page}`);
    if (r.status === 403) return { result: 'forbidden' };
    if (r.status !== 200) throw new Error(`listing comments on #${number}: HTTP ${r.status}: ${r.text}`);
    const comments = Array.isArray(r.json) ? r.json : [];
    found = comments.find((c) => typeof c.body === 'string' && c.body.startsWith(marker)) || null;
    if (comments.length < 100) break;
  }
  if (found) {
    const r = await rest('PATCH', `/repos/${repository}/issues/comments/${found.id}`, { body });
    if (r.status === 200) return { result: 'updated', url: r.json.html_url || found.html_url };
    if (r.status === 403) return { result: 'forbidden' };
    throw new Error(`updating comment ${found.id}: HTTP ${r.status}: ${r.text}`);
  }
  if (!create) return { result: 'skipped' };
  const r = await rest('POST', `/repos/${repository}/issues/${number}/comments`, { body });
  if (r.status === 201) return { result: 'created', url: r.json.html_url };
  if (r.status === 403) return { result: 'forbidden' };
  throw new Error(`commenting on #${number}: HTTP ${r.status}: ${r.text}`);
}

module.exports = { repoInfo, packageVisibility, findSelfJob, pullRequestOf, upsertComment };
