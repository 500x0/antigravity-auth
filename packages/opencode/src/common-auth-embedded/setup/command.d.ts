import type { SetupIO, SetupPlugin, SetupResult } from './types.js';
export declare const AMBIGUOUS_OPENCODE_MESSAGE = "Multiple OpenCode generations found. Choose --opencode=1|2|both before running noninteractive setup.";
export declare function runSetup(plugin: SetupPlugin, argv?: readonly string[], io?: SetupIO): Promise<SetupResult>;
