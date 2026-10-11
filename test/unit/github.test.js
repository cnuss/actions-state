'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { repoInfo, packageVisibility, findSelfJob } = require('../../src/core/github');

function stubRest(routes) {
  const calls = [];
  const rest = async (method, path) => {
    calls.push(`${method} ${path}`);
    const route = routes[`${method} ${path}`];
    if (!route) return { status: 404, json: {}, text: '' };
    const [status, json] = typeof route === 'function' ? route() : route;
    return { status, json, text: JSON.stringify(json) };
  };
  return { rest, calls };
}

test('repoInfo reads visibility, default branch and owner type', async () => {
  const { rest } = stubRest({ 'GET /repos/o/r': [200, { visibility: 'public', default_branch: 'main', owner: { type: 'User' } }] });
  assert.deepEqual(await repoInfo(rest, 'o/r'), { visibility: 'public', defaultBranch: 'main', ownerType: 'User' });
});

test('repoInfo falls back to the private flag when visibility is absent', async () => {
  const { rest } = stubRest({ 'GET /repos/o/r': [200, { private: true, default_branch: 'trunk', owner: { type: 'Organization' } }] });
  assert.equal((await repoInfo(rest, 'o/r')).visibility, 'private');
});

test('packageVisibility uses the users or orgs path with an encoded name', async () => {
  const user = stubRest({ 'GET /users/o/packages/container/r%2Factions-state': [200, { visibility: 'private' }] });
  assert.equal(await packageVisibility(user.rest, { ownerType: 'User', owner: 'o', packageName: 'r/actions-state' }), 'private');
  const org = stubRest({ 'GET /orgs/o/packages/container/r%2Factions-state': [200, { visibility: 'public' }] });
  assert.equal(await packageVisibility(org.rest, { ownerType: 'Organization', owner: 'o', packageName: 'r/actions-state' }), 'public');
});

test('packageVisibility is null when the package does not exist yet', async () => {
  const { rest } = stubRest({});
  assert.equal(await packageVisibility(rest, { ownerType: 'User', owner: 'o', packageName: 'r/actions-state' }), null);
});

test('findSelfJob matches the runner name among in-progress jobs, retrying while the API lags', async () => {
  let n = 0;
  const { rest } = stubRest({
    'GET /repos/o/r/actions/runs/9/attempts/1/jobs?per_page=100&page=1': () => {
      n += 1;
      const jobs = [{ id: 5, name: 'other', runner_name: 'GitHub Actions 2', status: 'in_progress', html_url: 'u5' }];
      if (n > 1) jobs.push({ id: 6, name: 'me', runner_name: 'GitHub Actions 1', status: 'in_progress', html_url: 'u6' });
      return [200, { jobs }];
    },
  });
  const env = { GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '9', GITHUB_RUN_ATTEMPT: '1', RUNNER_NAME: 'GitHub Actions 1' };
  assert.deepEqual(await findSelfJob(rest, env, { sleep: async () => {} }), { id: 6, name: 'me', url: 'u6' });
});

const selfEnv = { GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '9', GITHUB_RUN_ATTEMPT: '1', RUNNER_NAME: 'GitHub Actions 1' };
const jobsPath = 'GET /repos/o/r/actions/runs/9/attempts/1/jobs?per_page=100&page=1';

test('findSelfJob backs off for up to the timeout, then names the runner', async () => {
  const slept = [];
  const { rest, calls } = stubRest({ [jobsPath]: [200, { jobs: [] }] });
  await assert.rejects(findSelfJob(rest, selfEnv, { sleep: async (ms) => { slept.push(ms); } }),
    /could not find this job \(runner "GitHub Actions 1"\) in run 9 attempt 1 within 60 s: not listed yet/);
  assert.deepEqual(slept, [1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000, 8000]);
  assert.equal(calls.length, 10);
});

test('findSelfJob retries server errors and rate limits but not other errors', async () => {
  let n = 0;
  const { rest } = stubRest({
    [jobsPath]: () => {
      n += 1;
      if (n === 1) return [502, {}];
      if (n === 2) return [429, {}];
      return [200, { jobs: [{ id: 6, name: 'me', runner_name: 'GitHub Actions 1', status: 'in_progress', html_url: 'u6' }] }];
    },
  });
  assert.equal((await findSelfJob(rest, selfEnv, { sleep: async () => {} })).id, 6);
  const { rest: denied } = stubRest({ [jobsPath]: [403, { message: 'no' }] });
  await assert.rejects(findSelfJob(denied, selfEnv, { sleep: async () => { throw new Error('slept'); } }), /listing this run's jobs: HTTP 403/);
});

test('findSelfJob takes a job not yet marked in progress but skips completed jobs on the same runner name', async () => {
  const { rest } = stubRest({
    [jobsPath]: [200, { jobs: [
      { id: 4, name: 'earlier', runner_name: 'GitHub Actions 1', status: 'completed', html_url: 'u4' },
      { id: 6, name: 'me', runner_name: 'GitHub Actions 1', status: 'queued', html_url: 'u6' },
    ] }],
  });
  assert.equal((await findSelfJob(rest, selfEnv, { sleep: async () => {} })).id, 6);
});
