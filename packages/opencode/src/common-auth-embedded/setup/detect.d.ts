import type { SetupDetection, SetupFileSystem, SetupIO, SetupPlugin } from './types.js';
export declare const defaultSetupFileSystem: SetupFileSystem;
export declare function findExecutableOnPath(name: string, io?: SetupIO): string | null;
export declare function openCodeDesktopMarkers(io?: SetupIO): string[];
export declare function detectOpenCodeGeneration(io?: SetupIO): '1' | '2' | 'ambiguous';
export declare function detectHosts(plugin: SetupPlugin, io?: SetupIO): Promise<SetupDetection>;
