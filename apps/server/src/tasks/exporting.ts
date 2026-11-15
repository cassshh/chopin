/**
 * Documents whose tasks are being made into GitHub issues in this process. Kept apart from the
 * export itself so a build start can refuse during one without importing it.
 */
let running = new Set<string>();

export function exporting(channelId: string): boolean {
	return running.has(channelId);
}

/** Mark an export under way; false when one already is. */
export function startExport(channelId: string): boolean {
	if (running.has(channelId)) return false;
	running.add(channelId);
	return true;
}

export function endExport(channelId: string): void {
	running.delete(channelId);
}
