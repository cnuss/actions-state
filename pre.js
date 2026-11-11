'use strict';

// The action's pre step: takes the state lock before the job's other steps run.

const { pre } = require('./index');

pre().catch((err) => {
  process.stdout.write(`::error::${err.message}\n`);
  process.exitCode = 1;
});
