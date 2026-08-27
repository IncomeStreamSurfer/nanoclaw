import { registerProviderSetupContract } from './registry.js';

// Claude is built into the checkout: nothing to install or verify, and the
// standard Anthropic auth step covers it.
registerProviderSetupContract('claude', {
  installOffer: 'built-in',
  image: 'hardened-compatible',
  auth: 'standard',
  installVerification: 'none',
  failureAssist: 'claude-fallback',
});
