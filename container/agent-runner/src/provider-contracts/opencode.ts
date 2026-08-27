import {
  planMemorySessionHookRun,
  resolveOpenCodeExecutionPolicy,
  resolveOpenCodeInference,
  resolveOpenCodeMcpServers,
  type OpenCodeMemorySource,
} from '../providers/opencode.js';

import { registerProviderRuntimeContract } from './registry.js';

const STARTUP: OpenCodeMemorySource = 'startup';

registerProviderRuntimeContract('opencode', {
  // OpenCode receives its generated config through the process environment
  // (OPENCODE_CONFIG_CONTENT) — core writes no files for it.
  managedFiles: [],
  configuration: {
    executionPolicy: { resolve: resolveOpenCodeExecutionPolicy },
    inference: {
      resolve: (input, environment) => resolveOpenCodeInference(input, environment),
      // OpenCode selects its model through the OPENCODE_* environment the
      // host provisions; the core input only steers reasoning effort, and
      // only for an explicitly registered model — so the probe declares the
      // environment under which that steering is observable.
      probes: {
        a: { effort: 'low' },
        b: { effort: 'high' },
        environment: { OPENCODE_PROVIDER: 'openai', OPENCODE_MODEL: 'openai/nanoclaw-probe-model' },
      },
    },
    // OpenCode has no native session-start hook file; the provider runs the
    // planned hook command itself when a context window is built.
    memory: { resolve: (hook) => planMemorySessionHookRun(hook, STARTUP) },
    mcpServers: { resolve: (servers, environment) => resolveOpenCodeMcpServers(servers, environment) },
  },
  // OpenCode persists and compacts its own session history under
  // XDG_DATA_HOME, so core executes no archives and no rotation for it.
  traceReaders: [],
  textDelivery: 'result',
  compaction: 'provider-native',
  commands: { formatting: 'xml', nativeAdmin: [], nativeFiltered: [] },
});
