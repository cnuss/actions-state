'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { repoInfo, packageVisibility, findSelfJob, pullRequestOf, upsertComment } = require('../../src/core/github');

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

test('pullRequestOf reads the number and head commit on pull request events only', () => {
  const event = JSON.stringify({ pull_request: { number: 7, head: { sha: 'abc' } } });
  const read = () => event;
  assert.deepEqual(pullRequestOf({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: '/e' }, read), { number: 7, headSha: 'abc' });
  assert.deepEqual(pullRequestOf({ GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_EVENT_PATH: '/e' }, read), { number: 7, headSha: 'abc' });
  assert.equal(pullRequestOf({ GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: '/e' }, read), null);
  assert.equal(pullRequestOf({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: '/e' }, () => '{'), null);
  assert.equal(pullRequestOf({ GITHUB_EVENT_NAME: 'pull_request' }, read), null);
});

function commentRest(routes) {
  const calls = [];
  const rest = async (method, path, body) => {
    calls.push({ call: `${method} ${path}`, body });
    const route = routes[`${method} ${path}`];
    const [status, json] = route ? (typeof route === 'function' ? route() : route) : [404, {}];
    return { status, json, text: JSON.stringify(json) };
  };
  return { rest, calls };
}

const M = '<!-- actions-state:plan:root -->';
const list = (page) => `GET /repos/o/r/issues/5/comments?per_page=100&page=${page}`;

test('upsertComment updates the comment that starts with the marker, looking past the first page', async () => {
  const filler = Array.from({ length: 100 }, (_, i) => ({ id: i, body: `x ${M}` }));
  const { rest, calls } = commentRest({
    [list(1)]: [200, filler],
    [list(2)]: [200, [{ id: 500, body: `${M}\nold`, html_url: 'u500' }]],
    'PATCH /repos/o/r/issues/comments/500': [200, { html_url: 'u500' }],
  });
  const r = await upsertComment(rest, { repository: 'o/r', number: 5, marker: M, body: `${M}\nnew` });
  assert.deepEqual(r, { result: 'updated', url: 'u500' });
  assert.deepEqual(calls.at(-1), { call: 'PATCH /repos/o/r/issues/comments/500', body: { body: `${M}\nnew` } });
});

test('upsertComment adds a comment when none has the marker, unless create is false', async () => {
  const routes = { [list(1)]: [200, [{ id: 1, body: 'hello' }]], 'POST /repos/o/r/issues/5/comments': [201, { html_url: 'u2' }] };
  assert.deepEqual(await upsertComment(commentRest(routes).rest, { repository: 'o/r', number: 5, marker: M, body: M }), { result: 'created', url: 'u2' });
  const { rest, calls } = commentRest(routes);
  assert.deepEqual(await upsertComment(rest, { repository: 'o/r', number: 5, marker: M, body: M, create: false }), { result: 'skipped' });
  assert.deepEqual(calls.map((c) => c.call), [list(1)]);
});

test('upsertComment reports a token that may not comment as forbidden and throws on other errors', async () => {
  const forbidden = { [list(1)]: [200, []], 'POST /repos/o/r/issues/5/comments': [403, { message: 'Resource not accessible by integration' }] };
  assert.deepEqual(await upsertComment(commentRest(forbidden).rest, { repository: 'o/r', number: 5, marker: M, body: M }), { result: 'forbidden' });
  const broken = { [list(1)]: [500, { message: 'boom' }] };
  await assert.rejects(upsertComment(commentRest(broken).rest, { repository: 'o/r', number: 5, marker: M, body: M }), /listing comments on #5: HTTP 500/);
});
