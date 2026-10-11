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

module.exports = { repoInfo, packageVisibility, findSelfJob };
