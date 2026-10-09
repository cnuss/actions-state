'use strict';

const { runOutputs } = require('../index');

runOutputs().catch((err) => {
  process.stdout.write(`::error::${err.message}\n`);
  process.exitCode = 1;
});
