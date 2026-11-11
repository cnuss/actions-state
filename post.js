'use strict';

// The action's post step: stops the server and releases the job's lock. It runs
// even when the main step was skipped (pre took the lock), so it is its own entry.

const { post } = require('./index');

post().catch((err) => {
  process.stdout.write(`::error::${err.message}\n`);
  process.exitCode = 1;
});
