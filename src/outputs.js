'use strict';

// Step outputs from tool outputs. Sensitive values stay out unless asked for,
// because GitHub drops job outputs that contain masked values.

const RESERVED = new Set(['json', 'sensitive']);

function toStepOutputs(outputs, { includeSensitive = false } = {}) {
  const entries = [];
  const values = {};
  const sensitive = [];
  const masks = [];
  const warnings = [];
  for (const [name, { value, sensitive: isSensitive }] of Object.entries(outputs)) {
    if (isSensitive) sensitive.push(name);
    if (isSensitive && !includeSensitive) continue;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (isSensitive) masks.push(...text.split('\n').filter(Boolean));
    values[name] = value;
    if (RESERVED.has(name)) {
      warnings.push(`output "${name}" is only in the json output: the name is taken`);
      continue;
    }
    entries.push([name, text]);
  }
  return { entries, json: JSON.stringify(values), sensitive, masks, warnings };
}

module.exports = { toStepOutputs };
