import { defaultCommandRunner } from './command-runner.js';
// A cold PowerShell/WMI query took 13.8 s on Windows Server 2022; warm queries
// took less than 0.5 s. This is the product's one-shot latency budget, not a test
// deadline: 45 s is about three times the worst measured cold start.
const WINDOWS_CIM_TIMEOUT_MS = 45_000;
const HOST_PATTERN = /(?:^|[/\\])(opencode|litecode|opencode2|pi)(?:\.(?:exe|cmd|bat|m?js))?(?=$|\s|")/i;
const PI_SCRIPT_PATTERN = /(?:^|[/\\])pi-coding-agent[/\\]dist[/\\](?:(?:bundle|bun)[/\\])?cli\.m?js(?=$|\s|")/i;
function hostName(command) {
    return (HOST_PATTERN.exec(command)?.[1] ??
        (PI_SCRIPT_PATTERN.test(command) ? 'pi' : null));
}
export class ProcessInspectionError extends Error {
    code = 'process-inspection-failed';
    step;
    exitCode;
    signal;
    timedOut;
    durationMs;
    constructor(details) {
        super('Process inspection failed; setup cannot prove hosts are stopped.');
        this.name = 'ProcessInspectionError';
        this.step = details.step;
        this.exitCode = details.exitCode;
        this.signal = details.signal;
        this.timedOut = details.timedOut;
        this.durationMs = details.durationMs;
    }
    get refusalText() {
        const outcome = this.timedOut
            ? 'timed out'
            : this.signal
                ? `signal ${this.signal}`
                : this.exitCode === null
                    ? 'could not start or complete'
                    : this.exitCode === 0
                        ? 'invalid output (exit code 0)'
                        : `exit code ${this.exitCode}`;
        return `${this.message} ${this.step}: ${outcome} after ${Math.round(this.durationMs)} ms.`;
    }
}
export class ProcessFenceViolationError extends Error {
    activeHosts;
    constructor(activeHosts) {
        // Process arguments may contain credentials; report only the recognized host name.
        const safeHosts = activeHosts.map((host) => ({
            pid: host.pid,
            command: hostName(host.command) ?? 'host',
        }));
        super(`OpenCode or Pi processes are currently running:\n${safeHosts.map((host) => `  - PID ${host.pid}: ${host.command}`).join('\n')}\n\nPlease quit all OpenCode, LiteCode, and Pi processes before running setup.`);
        this.activeHosts = safeHosts;
        this.name = 'ProcessFenceViolationError';
    }
}
/** List processes before filtering hosts; Windows PID 0 is a valid idle-process row. */
export async function listSetupProcesses(runner = defaultCommandRunner, options = {}) {
    const windows = (options.platform ?? process.platform) === 'win32';
    let inspection = {
        step: windows ? 'tasklist' : 'ps',
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: 0,
    };
    const inspect = async (step, file, args, timeoutMs) => {
        const started = performance.now();
        inspection = {
            step,
            exitCode: null,
            signal: null,
            timedOut: false,
            durationMs: 0,
        };
        try {
            const result = await runner.run(file, args, {
                env: options.env,
                timeoutMs,
            });
            inspection = {
                step,
                exitCode: result.exitCode,
                signal: result.signal ?? null,
                timedOut: result.timedOut ?? false,
                durationMs: result.durationMs ?? performance.now() - started,
            };
            return result;
        }
        finally {
            if (inspection.exitCode === null)
                inspection.durationMs = performance.now() - started;
            options.onStep?.({ ...inspection });
        }
    };
    try {
        const result = await inspect(windows ? 'tasklist' : 'ps', windows ? 'tasklist.exe' : 'ps', windows ? ['/fo', 'csv', '/nh'] : ['-eo', 'pid,command']);
        if (result.exitCode !== 0)
            throw new ProcessInspectionError(inspection);
        const processes = [];
        for (const line of result.stdout.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            let pid;
            let command;
            if (windows) {
                const match = /^"([^"]+)","(\d+)"(?:,|$)/.exec(trimmed);
                if (!match)
                    throw new ProcessInspectionError(inspection);
                command = match[1] ?? '';
                pid = Number(match[2]);
            }
            else {
                const match = /^(\d+)\s+(.+)$/.exec(trimmed);
                if (!match) {
                    if (/^PID\s+COMMAND$/i.test(trimmed))
                        continue;
                    throw new ProcessInspectionError(inspection);
                }
                pid = Number(match[1]);
                command = match[2] ?? '';
            }
            if (!Number.isSafeInteger(pid) || pid < 0)
                throw new ProcessInspectionError(inspection);
            processes.push({ pid, command });
        }
        if (!processes.length)
            throw new ProcessInspectionError(inspection);
        // tasklist identifies native hosts, but npm Pi/OpenCode scripts appear as Node or Bun.
        const runtimes = processes.filter((entry) => entry.pid !== process.pid && /^(?:node|bun)\.exe$/i.test(entry.command));
        if (windows && runtimes.length) {
            const details = await inspect('CIM', 'powershell.exe', [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process -Filter \"Name = 'node.exe' OR Name = 'bun.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
            ], WINDOWS_CIM_TIMEOUT_MS);
            if (details.exitCode !== 0)
                throw new ProcessInspectionError(inspection);
            const value = JSON.parse(details.stdout || 'null');
            const rows = value === null ? [] : Array.isArray(value) ? value : [value];
            const commands = new Map();
            for (const row of rows) {
                if (!row ||
                    typeof row !== 'object' ||
                    !('ProcessId' in row) ||
                    !('CommandLine' in row) ||
                    !Number.isSafeInteger(row.ProcessId))
                    throw new ProcessInspectionError(inspection);
                if (typeof row.CommandLine === 'string')
                    commands.set(Number(row.ProcessId), row.CommandLine);
                else if (runtimes.some((entry) => entry.pid === row.ProcessId))
                    throw new ProcessInspectionError(inspection);
            }
            for (const entry of runtimes) {
                // A process absent from the later CIM snapshot already exited.
                entry.command = commands.get(entry.pid) ?? '';
            }
        }
        return processes;
    }
    catch (error) {
        if (error instanceof ProcessInspectionError)
            throw error;
        throw new ProcessInspectionError(inspection);
    }
}
export function createProcessFence(runner = defaultCommandRunner, options = {}) {
    return {
        async listRunningHosts(env) {
            return (await listSetupProcesses(runner, { ...options, env })).filter((entry) => entry.pid !== process.pid && hostName(entry.command) !== null);
        },
    };
}
export async function assertHostsStopped(fence, env) {
    const active = await fence.listRunningHosts(env);
    if (active.length)
        throw new ProcessFenceViolationError(active);
}
