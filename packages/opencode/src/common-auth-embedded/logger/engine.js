import { appendFileSync, chmodSync, existsSync, renameSync, statSync, } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createPrivateBytes, ensurePrivateDirectory, privateOperation, replaceWindowsFile, verifyPrivate, windowsPrivateFiles, } from '../fs/private-files.js';
import { createRedactor } from './redact.js';
const ORDER = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
    trace: 4,
};
const MAX_BYTES = 5 * 1024 * 1024;
const ROTATE_KEEP = 3;
function chmodPrivate(path) {
    try {
        chmodSync(path, 0o600);
    }
    catch {
        /* never throw */
    }
}
function rotateIfNeeded(f) {
    try {
        if (!(existsSync(f) && statSync(f).size >= MAX_BYTES))
            return;
        for (let i = ROTATE_KEEP - 1; i >= 1; i--) {
            if (existsSync(`${f}.${i}`)) {
                const rotated = `${f}.${i + 1}`;
                renameSync(`${f}.${i}`, rotated);
                chmodPrivate(rotated);
            }
        }
        const rotated = `${f}.1`;
        renameSync(f, rotated);
        chmodPrivate(rotated);
    }
    catch {
        /* never throw */
    }
}
async function closeWindowsFile(sink) {
    const { file, handle } = sink;
    sink.file = undefined;
    sink.handle = undefined;
    if (file && handle)
        await privateOperation(file, 'log-close', () => handle.close());
}
async function openWindowsFile(sink, file) {
    await ensurePrivateDirectory(dirname(file));
    try {
        await verifyPrivate(file, 'file', true);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        try {
            await createPrivateBytes(file, '');
        }
        catch (creationError) {
            if (creationError.code !== 'EEXIST')
                throw creationError;
            await verifyPrivate(file, 'file', true);
        }
    }
    // The parent's verified protected owner-only DACL denies other ordinary users the ability to create, replace or link entries between verification and fs.open.
    // This protects against other ordinary users, not the owner or administrators, whose ability to change that namespace is outside our threat model.
    sink.handle = await privateOperation(file, 'log-open', () => open(file, 'a'));
    sink.file = file;
    return sink.handle;
}
async function flushWindowsFile(sink, file, text) {
    file = resolve(file);
    try {
        if (sink.file !== file)
            await closeWindowsFile(sink);
        let handle = sink.handle ?? (await openWindowsFile(sink, file));
        const info = await privateOperation(file, 'log-stat', () => handle.stat());
        if (info.size >= MAX_BYTES) {
            await closeWindowsFile(sink);
            for (let i = ROTATE_KEEP - 1; i >= 0; i--) {
                const source = i === 0 ? file : `${file}.${i}`;
                const target = `${file}.${i + 1}`;
                try {
                    await verifyPrivate(source, 'file', true);
                }
                catch (error) {
                    if (error.code === 'ENOENT')
                        continue;
                    throw error;
                }
                try {
                    await verifyPrivate(target, 'file', true);
                }
                catch (error) {
                    if (error.code !== 'ENOENT')
                        throw error;
                }
                await replaceWindowsFile(source, target);
                await verifyPrivate(target, 'file');
            }
            handle = await openWindowsFile(sink, file);
        }
        await privateOperation(file, 'log-append', () => handle.appendFile(text, 'utf8'));
    }
    catch (error) {
        await closeWindowsFile(sink).catch(() => { });
        throw error;
    }
}
function safeSerialize(data) {
    try {
        return ` ${JSON.stringify(data)}`;
    }
    catch {
        return ' [unserializable]';
    }
}
/**
 * One logger's settings and buffer.
 *
 * Where lines are written and the level floor start unset unless `options`
 * supplies them. A host decides where its log lives (that decision reads host
 * environment variables and host directories, neither of which belongs in
 * shared code) and configures the logger before it runs any command. Until
 * then every `log.*` call is a silent no-op: throwing would turn the first
 * command a host forgot to wire into a crash, and buffering would hold
 * credential-bearing lines for a configuration that may never arrive.
 */
function createEngine(options) {
    let logFileSource;
    let initLevelSource;
    let runtimeLevel;
    let redactor = createRedactor();
    let captureSink;
    let buffer = [];
    let timer;
    let orderedSink = Promise.resolve();
    let sinkError;
    const windowsFile = {};
    function queueWindows(operation) {
        const next = orderedSink.then(operation);
        orderedSink = next.catch((error) => {
            sinkError = error;
        });
        return next;
    }
    function configure(next) {
        if (windowsPrivateFiles && next.file !== logFileSource)
            void queueWindows(() => closeWindowsFile(windowsFile)).catch(() => { });
        logFileSource = next.file;
        initLevelSource = next.level;
        redactor = createRedactor(next);
        captureSink = next.captureSink;
    }
    function setLogLevel(l) {
        if (l === undefined || l in ORDER)
            runtimeLevel = l;
    }
    function logFilePath() {
        if (logFileSource === undefined)
            return undefined;
        const resolved = typeof logFileSource === 'function' ? logFileSource() : logFileSource;
        return resolved || undefined;
    }
    function configuredLevel() {
        if (runtimeLevel)
            return runtimeLevel;
        const floor = typeof initLevelSource === 'function'
            ? initLevelSource()
            : initLevelSource;
        if (floor && floor in ORDER)
            return floor;
        return 'info';
    }
    function flushLogs(close = true) {
        if (timer) {
            clearTimeout(timer);
            timer = undefined;
        }
        if (!buffer.length) {
            if (windowsPrivateFiles)
                return queueWindows(async () => {
                    if (close)
                        await closeWindowsFile(windowsFile);
                    if (sinkError)
                        throw sinkError;
                });
            return;
        }
        let file;
        try {
            file = logFilePath();
        }
        catch {
            buffer = [];
            if (windowsPrivateFiles && close)
                return queueWindows(() => closeWindowsFile(windowsFile));
            return;
        }
        const text = buffer.join('');
        buffer = [];
        if (!file) {
            if (windowsPrivateFiles && close)
                return queueWindows(() => closeWindowsFile(windowsFile));
            return;
        }
        if (windowsPrivateFiles) {
            return queueWindows(async () => {
                try {
                    await flushWindowsFile(windowsFile, file, text);
                }
                finally {
                    if (close)
                        await closeWindowsFile(windowsFile);
                }
            });
        }
        try {
            rotateIfNeeded(file);
            if (existsSync(file))
                chmodPrivate(file);
            appendFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
        }
        catch {
            /* never throw */
        }
    }
    function schedule() {
        if (!timer)
            timer = setTimeout(() => {
                timer = undefined;
                const flushed = flushLogs(false);
                if (flushed instanceof Promise)
                    void flushed.catch(() => { });
            }, 500);
    }
    function emit(channel, level, message, data) {
        // Unconfigured (neither a file nor a sink) stays a silent no-op.
        if (logFileSource === undefined && captureSink === undefined)
            return;
        try {
            if (ORDER[level] > ORDER[configuredLevel()])
                return;
            const scrubbedMessage = redactor.redactStrings(message);
            let scrubbedData;
            try {
                scrubbedData = redactor.redact(data);
            }
            catch {
                scrubbedData = '[unserializable]';
            }
            const line = `[${new Date().toISOString()}] ${level.toUpperCase()} [${channel}] ${scrubbedMessage}` +
                (data === undefined ? '' : safeSerialize(scrubbedData)) +
                '\n';
            // A failing observer must not prevent file logging or escape into the host.
            try {
                captureSink?.({
                    channel,
                    level,
                    message: scrubbedMessage,
                    data: scrubbedData,
                });
            }
            catch { }
            // A sink-only logger has no file to buffer lines for.
            if (logFileSource === undefined)
                return;
            buffer.push(line);
            if (buffer.length >= 50) {
                const flushed = flushLogs(false);
                if (flushed instanceof Promise)
                    void flushed.catch(() => { });
            }
            else
                schedule();
        }
        catch {
            // Provider and redaction failures must never turn diagnostics into a host crash.
        }
    }
    function createLogger(channel) {
        return {
            error: (m, d) => emit(channel, 'error', m, d),
            warn: (m, d) => emit(channel, 'warn', m, d),
            info: (m, d) => emit(channel, 'info', m, d),
            debug: (m, d) => emit(channel, 'debug', m, d),
            trace: (m, d) => emit(channel, 'trace', m, d),
        };
    }
    function reset() {
        if (windowsPrivateFiles)
            void queueWindows(() => closeWindowsFile(windowsFile)).catch(() => { });
        sinkError = undefined;
        buffer = [];
        if (timer) {
            clearTimeout(timer);
            timer = undefined;
        }
        logFileSource = undefined;
        initLevelSource = undefined;
        runtimeLevel = undefined;
        redactor = createRedactor();
        captureSink = undefined;
    }
    if (options)
        configure(options);
    return { configure, createLogger, setLogLevel, flushLogs, reset };
}
/**
 * A logger instance of its own, configured with `options`. A plugin whose
 * copy of this module may be shared with another plugin in the same process
 * uses this instead of `initLogger`, so neither replaces the other's file,
 * level, redaction or capture sink.
 */
export function createLoggerInstance(options) {
    const { configure, createLogger, setLogLevel, flushLogs } = createEngine(options);
    return { configure, createLogger, setLogLevel, flushLogs };
}
/**
 * The instance behind the module-level functions below, which keep the
 * single-plugin API: one plugin per copy of this module calls `initLogger`
 * and `createLogger` without holding an instance.
 */
const defaultEngine = createEngine();
/**
 * Point the module's default logger at a host's file and level, and return
 * it. Idempotent: calling it again replaces both. A runtime level installed
 * by `setLogLevel` is deliberately left alone, because it is the operator's
 * explicit choice and outranks the floor a host computed at start-up.
 */
export function initLogger(options) {
    defaultEngine.configure(options);
    const { configure, createLogger, setLogLevel, flushLogs } = defaultEngine;
    return { configure, createLogger, setLogLevel, flushLogs };
}
export function setLogLevel(l) {
    defaultEngine.setLogLevel(l);
}
/**
 * Write whatever the default logger has buffered. On Windows await the
 * promise before shutdown; POSIX keeps synchronous process-exit flushing.
 */
export function flushLogs() {
    return defaultEngine.flushLogs();
}
export function createLogger(channel) {
    return defaultEngine.createLogger(channel);
}
export async function flushForTest() {
    return defaultEngine.flushLogs();
}
/**
 * Return the default logger to its uninitialised state. Only a test needs
 * this: a single process runs every test file, so a file path left over from
 * one test would keep a later "logger was never initialised" case writing
 * lines.
 */
export function resetLoggerForTest() {
    defaultEngine.reset();
}
