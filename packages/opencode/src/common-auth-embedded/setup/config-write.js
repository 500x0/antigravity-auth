import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
/** Ordinary host config inherits Windows ACLs and preserves an existing POSIX mode. */
export async function writeHostConfigAtomic(file, content, options = {}) {
    const windows = (options.platform ?? process.platform) === 'win32';
    const parent = dirname(file);
    await mkdir(parent, { recursive: true });
    let mode;
    if (!windows) {
        try {
            mode = (await stat(file)).mode & 0o7777;
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }
    const stage = join(parent, `.${basename(file)}.${(options.stageName ?? randomUUID)()}.tmp`);
    let created = false;
    try {
        const handle = await open(stage, 'wx', mode ?? 0o666);
        created = true;
        try {
            await handle.writeFile(content, 'utf8');
            // An existing mode is deliberate; restore bits masked by the current umask.
            if (mode !== undefined)
                await handle.chmod(mode);
        }
        finally {
            await handle.close();
        }
        const now = options.now ?? (() => performance.now());
        const started = now();
        for (let attempt = 0;; attempt++) {
            await options.beforeRename?.();
            try {
                await (options.rename ?? rename)(stage, file);
                created = false;
                return;
            }
            catch (error) {
                const code = error.code;
                const remaining = 2000 - (now() - started);
                if (!windows ||
                    !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '') ||
                    remaining <= 0 ||
                    attempt >= 40)
                    throw new Error(`Unable to replace host config ${file}. Close editors or other programs using the file, then rerun setup.`);
                await (options.wait ?? delay)(Math.min(remaining, 25 * 2 ** Math.min(attempt, 2)));
            }
        }
    }
    finally {
        // Never remove a colliding stage that this call did not create.
        if (created)
            await unlink(stage).catch(() => { });
    }
}
