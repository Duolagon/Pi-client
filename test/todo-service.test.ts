import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TodoService } from "../src/todo-service.ts";
import type { TodoEvent } from "../src/todo-types.ts";
import { validateDesktopToolInput } from "../src/tool-control-types.ts";

test("TodoService persists shared checklist items, maintains bidirectional dependencies, and rejects cycles", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-todo-service-"));
	try {
		const service = new TodoService({ dataDir: () => dir });
		const events: TodoEvent[] = [];
		const unsub = service.subscribe((event) => events.push(event));

		const t1 = await service.create("root-1", {
			subject: "Design schema",
			description: "Define persistent todo schema and validation rules",
			activeForm: "Designing schema",
			owner: "architect",
			metadata: { phase: "p8", priority: 1 },
		});
		assert.equal(t1.id, "1");
		assert.equal(t1.status, "pending");
		assert.equal(t1.owner, "architect");

		const t2 = await service.create("root-1", {
			subject: "Implement service",
			description: "Build TodoService with atomic writes",
			blockedBy: ["1"],
		});
		assert.equal(t2.id, "2");
		assert.deepEqual(t2.blockedBy, ["1"]);

		// Bidirectional link added onto t1.blocks automatically
		const fetchedT1 = await service.get("root-1", { id: "1" });
		assert.deepEqual(fetchedT1?.blocks, ["2"]);

		// Creating or adding a cycle is rejected
		await assert.rejects(
			service.update("root-1", { id: "1", addBlockedBy: ["2"] }),
			/cycle/,
		);
		await assert.rejects(
			service.update("root-1", { id: "1", addBlockedBy: ["1"] }),
			/itself/,
		);

		// Metadata merge + null key removal + status update
		const updated = await service.update("root-1", {
			id: "1",
			status: "in_progress",
			metadata: { priority: null, reviewed: true },
		});
		assert.equal(updated.status, "in_progress");
		assert.deepEqual(updated.metadata, { phase: "p8", reviewed: true });

		// Reload from disk via fresh TodoService instance (persistence across restarts)
		const reloaded = new TodoService({ dataDir: () => dir });
		const listed = await reloaded.list("root-1");
		assert.equal(listed.length, 2);
		assert.equal(listed[0].status, "in_progress");

		// Deleting t1 clears it from list and removes dangling edges on t2
		await reloaded.update("root-1", { id: "1", status: "deleted" });
		const afterDelete = await reloaded.list("root-1");
		assert.equal(afterDelete.length, 1);
		assert.equal(afterDelete[0].id, "2");
		assert.deepEqual(afterDelete[0].blockedBy, []);
		assert.equal(await reloaded.get("root-1", { id: "1" }), null);

		unsub();
		assert.equal(events.length, 3);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("TodoService enforces root isolation and Todo* desktop input validation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-todo-iso-"));
	try {
		const service = new TodoService({ dataDir: () => dir });
		await service.create("conv-a", { subject: "Task A", description: "Only in conv-a" });
		await service.create("conv-b", { subject: "Task B", description: "Only in conv-b" });
		assert.deepEqual((await service.list("conv-a")).map((t) => t.subject), ["Task A"]);
		assert.deepEqual((await service.list("conv-b")).map((t) => t.subject), ["Task B"]);

		assert.throws(() => validateDesktopToolInput("TodoCreate", { subject: "", description: "ok" }), /Invalid subject/);
		assert.throws(() => validateDesktopToolInput("TodoUpdate", { id: "1", status: "unknown" }), /Invalid todo status/);
		assert.throws(() => validateDesktopToolInput("TodoGet", { id: "1", extra: true }), /Unknown tool input field/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
