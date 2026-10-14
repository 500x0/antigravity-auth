import { select } from '../auth-menu/select.js';
/** Reuse the terminal selector for a toggle list with an explicit final choice. */
export async function selectSetupHosts(terminal, found) {
    const selected = new Set(found);
    for (;;) {
        const choice = await select(terminal, [
            ...['opencode', 'pi'].map((host) => ({
                value: host,
                label: `[${selected.has(host) ? 'x' : ' '}] ${host === 'opencode' ? 'OpenCode' : 'Pi'}`,
                hint: found.includes(host) ? 'found' : 'not found',
            })),
            { value: 'done', label: 'Continue with selected hosts' },
        ], {
            message: 'Select hosts to set up',
            subtitle: 'Enter toggles a host; choose Continue when ready.',
        });
        if (choice === null)
            return null;
        if (choice === 'done')
            return [...selected];
        if (selected.has(choice))
            selected.delete(choice);
        else
            selected.add(choice);
    }
}
