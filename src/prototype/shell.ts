import { app, BrowserWindow, Menu } from "electron";
import { join } from "node:path";
let window: BrowserWindow | null = null;
app.setName("Pi Desktop Preview");
app.setPath("userData", join(app.getPath("appData"), "Pi Desktop Preview"));
function openWindow() {
	window = new BrowserWindow({
		width: 1480,
		height: 980,
		minWidth: 780,
		minHeight: 620,
		title: "Pi Desktop Preview",
		titleBarStyle: "hidden",
		trafficLightPosition: { x: 20, y: 17 },
		backgroundColor: "#faf9f6",
		webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
	});
	void window.loadFile(join(__dirname, "index.html"));
	window.webContents.on("did-finish-load", () => {
		void window?.webContents.executeJavaScript('document.documentElement.dataset.native = "true"');
	});
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	window.webContents.on("will-navigate", (event) => event.preventDefault());
	window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
	window.on("closed", () => {
		window = null;
	});
}
void app.whenReady().then(() => {
	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			{
				label: "Pi Desktop Preview",
				submenu: [{ role: "about" }, { type: "separator" }, { role: "hide" }, { role: "quit" }],
			},
			{
				label: "Edit",
				submenu: [
					{ role: "undo" },
					{ role: "redo" },
					{ type: "separator" },
					{ role: "cut" },
					{ role: "copy" },
					{ role: "paste" },
					{ role: "selectAll" },
				],
			},
			{
				label: "View",
				submenu: [
					{ role: "reload" },
					{ role: "toggleDevTools" },
					{ role: "resetZoom" },
					{ role: "zoomIn" },
					{ role: "zoomOut" },
					{ role: "togglefullscreen" },
				],
			},
			{ role: "windowMenu" },
		]),
	);
	openWindow();
	app.on("activate", () => {
		if (!window) openWindow();
	});
});
app.on("window-all-closed", () => app.quit());
