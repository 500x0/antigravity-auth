// Bundle the real setup and CLI factories for Node without exposing a public API.

export { createDefaultCliDependencies } from '../../packages/opencode/src/cli.ts'
export {
  assertSetupHostsStopped,
  createSetupPlugin,
} from '../../packages/opencode/src/setup.ts'
