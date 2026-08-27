import { registerProviderSetupContract } from './registry.js';

// OpenCode remains skill-only: interactive setup never offers it, its
// credentials are configured through OneCLI and provider environment
// settings, and the shared provider conformance suite is the install gate.
registerProviderSetupContract('opencode', {
  installOffer: 'none',
  installSkill: 'add-opencode',
  image: 'local-required',
  auth: 'none',
  installVerification: 'none',
  failureAssist: 'none',
});
