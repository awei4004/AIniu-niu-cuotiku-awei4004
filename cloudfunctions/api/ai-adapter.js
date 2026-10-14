const domain = require('./practice-domain');

// Provider calls belong here. Until a provider is configured, return explicit demo output.
async function generate(source, options) {
  return domain.demoGenerate(source, options);
}

module.exports = { generate, provider: 'demo' };
