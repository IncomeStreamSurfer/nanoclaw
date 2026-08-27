import './index.js';
import '../providers/index.js';
import { listProviderRuntimeContractNames } from './registry.js';
import { listProviderNames } from '../providers/provider-registry.js';

console.log(
  JSON.stringify({
    contracts: listProviderRuntimeContractNames().sort(),
    providers: listProviderNames().sort(),
  }),
);
