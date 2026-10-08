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

// This job, found by runner name among the run attempt's in-progress jobs. The
// jobs API can lag the job's start by a few seconds.
async function findSelfJob(rest, env, { attempts = 5, delayMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const { GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run, GITHUB_RUN_ATTEMPT: attempt, RUNNER_NAME: runner } = env;
  for (let tries = 1; tries <= attempts; tries += 1) {
    for (let page = 1; ; page += 1) {
      const r = await rest('GET', `/repos/${repo}/actions/runs/${run}/attempts/${attempt}/jobs?per_page=100&page=${page}`);
      if (r.status !== 200) throw new Error(`listing this run's jobs: HTTP ${r.status}: ${r.text}`);
      const jobs = r.json.jobs || [];
      const job = jobs.find((j) => j.runner_name === runner && j.status === 'in_progress');
      if (job) return { id: job.id, name: job.name, url: job.html_url };
      if (jobs.length < 100) break;
    }
    if (tries < attempts) await sleep(delayMs);
  }
  throw new Error(`could not find this job (runner "${runner}") in run ${run} attempt ${attempt}`);
}

module.exports = { repoInfo, packageVisibility, findSelfJob };
