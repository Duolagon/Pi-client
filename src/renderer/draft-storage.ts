import type { ComposerDraft } from "../composer-draft.ts";

const storeName = "drafts";
let database: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
	return database ??= new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open("pi-composer", 1);
		request.onupgradeneeded = () => request.result.createObjectStore(storeName);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	}).catch((error) => {
		database = undefined;
		throw error;
	});
}

export async function readDraft(id: string): Promise<ComposerDraft> {
	const store = (await open()).transaction(storeName).objectStore(storeName);
	const text = store.get([id, "text"]);
	const attachments = store.get([id, "attachments"]);
	return new Promise((resolve, reject) => {
		store.transaction.oncomplete = () => resolve({ text: text.result ?? "", attachments: attachments.result ?? [] });
		store.transaction.onabort = () => reject(store.transaction.error);
	});
}

/** Save the changed fields together, without rewriting image data at each keystroke. */
export async function writeDraft(id: string, patch: Partial<ComposerDraft>): Promise<void> {
	const store = (await open()).transaction(storeName, "readwrite").objectStore(storeName);
	for (const field of ["text", "attachments"] as const) {
		const value = patch[field];
		if (value === undefined) continue;
		if (value.length) store.put(value, [id, field]);
		else store.delete([id, field]);
	}
	return new Promise((resolve, reject) => {
		store.transaction.oncomplete = () => resolve();
		store.transaction.onabort = () => reject(store.transaction.error);
	});
}
