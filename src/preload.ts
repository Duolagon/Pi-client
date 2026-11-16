import { contextBridge, ipcRenderer } from "electron";
import type { DesktopAPI } from "./shared.ts";

function listen<T>(channel: string, listener: (event: T) => void): () => void {
	const handler = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload);
	ipcRenderer.on(channel, handler);
	return () => ipcRenderer.removeListener(channel, handler);
}

const api: DesktopAPI = {
	sessions: {
		fork: (input) => ipcRenderer.invoke("pi:session:fork", input),
		clone: (input) => ipcRenderer.invoke("pi:session:clone", input),
		entries: (input) => ipcRenderer.invoke("pi:session:entries", input),
		tree: (conversationId) => ipcRenderer.invoke("pi:session:tree", conversationId),
		forkMessages: (conversationId) => ipcRenderer.invoke("pi:session:fork-messages", conversationId),
		navigate: (input) => ipcRenderer.invoke("pi:session:navigate", input),
		history: (input) => ipcRenderer.invoke("pi:session:history", input),
		importHistory: (input) => ipcRenderer.invoke("pi:session:import-history", input),
	},
	git: {
		begin: (input) => ipcRenderer.invoke("pi:git:begin", input),
		finish: (input) => ipcRenderer.invoke("pi:git:finish", input),
		list: (conversationId) => ipcRenderer.invoke("pi:git:list", conversationId),
		diff: (input) => ipcRenderer.invoke("pi:git:diff", input),
		restore: (input) => ipcRenderer.invoke("pi:git:restore", input),
	},
	terminals: {
		create: (input) => ipcRenderer.invoke("pi:terminal:create", input),
		list: (conversationId) => ipcRenderer.invoke("pi:terminal:list", conversationId),
		write: (id, data) => ipcRenderer.invoke("pi:terminal:write", id, data),
		resize: (id, cols, rows) => ipcRenderer.invoke("pi:terminal:resize", id, cols, rows),
		close: (id) => ipcRenderer.invoke("pi:terminal:close", id),
		replay: (id, afterSequence) => ipcRenderer.invoke("pi:terminal:replay", id, afterSequence),
		onEvent: (listener) => listen("pi:terminal:event", listener),
	},
	tasks: {
		start: (input) => ipcRenderer.invoke("pi:task:start", input),
		list: () => ipcRenderer.invoke("pi:task:list"),
		snapshot: (id) => ipcRenderer.invoke("pi:task:snapshot", id),
		cancel: (id) => ipcRenderer.invoke("pi:task:cancel", id),
		command: (id, command) => ipcRenderer.invoke("pi:task:command", id, command),
		respond: (id, response) => ipcRenderer.invoke("pi:task:respond", id, response),
		files: (id, path) => ipcRenderer.invoke("pi:task:files", id, path),
		readFile: (id, path) => ipcRenderer.invoke("pi:task:read-file", id, path),
		workspace: (id) => ipcRenderer.invoke("pi:task:workspace", id),
		diff: (id, path) => ipcRenderer.invoke("pi:task:diff", id, path),
		onEvent: (listener) => listen("pi:task:event", listener),
	},
	worktrees: {
		create: (input) => ipcRenderer.invoke("pi:worktree:create", input),
		list: (project) => ipcRenderer.invoke("pi:worktree:list", project),
		remove: (id) => ipcRenderer.invoke("pi:worktree:remove", id),
		merge: (id) => ipcRenderer.invoke("pi:worktree:merge", id),
	},
	snapshot: () => ipcRenderer.invoke("pi:snapshot"),
	openProject: () => ipcRenderer.invoke("pi:open-project"),
	selectProject: (path) => ipcRenderer.invoke("pi:select-project", path),
	newConversation: () => ipcRenderer.invoke("pi:new-conversation"),
	selectConversation: (id) => ipcRenderer.invoke("pi:select-conversation", id),
	renameConversation: (id, title) => ipcRenderer.invoke("pi:rename", id, title),
	command: (command) => ipcRenderer.invoke("pi:command", command),
	respond: (response) => ipcRenderer.invoke("pi:respond", response),
	files: (path) => ipcRenderer.invoke("pi:files", path),
	readFile: (path) => ipcRenderer.invoke("pi:read-file", path),
	workspace: () => ipcRenderer.invoke("pi:workspace"),
	diff: (path) => ipcRenderer.invoke("pi:diff", path),
	saveSettings: (settings) => ipcRenderer.invoke("pi:settings", settings),
	testConnection: (input) => ipcRenderer.invoke("pi:test-connection", input),
	exportConversation: () => ipcRenderer.invoke("pi:export"),
	onEvent: (listener) => listen("pi:event", listener),
};
contextBridge.exposeInMainWorld("pi", api);
