import { registerProviderSetupContract } from './registry.js';

registerProviderSetupContract('codex', {
  installOffer: 'skill-descriptor',
  installSkill: 'add-codex',
  image: 'local-required',
  auth: 'provider',
  installVerification: 'provider',
  failureAssist: 'provider',
});
