'use strict';

// An adapter connects one tool to the state server:
//   check(dir, opts)       throws on configuration that conflicts with it
//   wire(dir, { endpoint }) writes the tool's configuration, returns env vars
//   unwire(dir)            removes what wire wrote and the saved plan
//   planArgs(existing)     TF_CLI_ARGS_plan that saves plans to PLAN_FILE
//   stateMeta(bytes)       { serial, lineage } for annotations and tags
//   stateOutputs(bytes)    { name: { value, sensitive } } of the root module
//   LAYER_MEDIA_TYPE       media type of the stored state
const ADAPTERS = {
  terraform: require('./terraform'),
};

function getAdapter(name) {
  const adapter = ADAPTERS[name];
  if (!adapter) throw new Error(`unknown adapter "${name}"`);
  return adapter;
}

module.exports = { getAdapter };
