import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TeamsService } from "../src/teams-service.ts";
import { validateDesktopToolInput } from "../src/tool-control-types.ts";

test("TeamsService enforces experimental agentTeams toggle, teammate directory lifecycle, and safe TeamDelete", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-teams-"));
	try {
		let enabled = false;
		const delivered: Array<{ conversationId: string; customType: string; content: string; details: Record<string, unknown> }> = [];
		const service = new TeamsService({
			dataDir: () => dir,
			isEnabled: () => enabled,
			deliver: async (conversationId, params) => {
				delivered.push({ conversationId, customType: params.customType, content: params.content, details: params.details });
				return "sent";
			},
		});

		// Disabled by default
		await assert.rejects(
			service.createTeam({ rootConversationId: "root-1", leaderConversationId: "root-1", team_name: "alpha" }),
			/agentTeams/,
		);

		enabled = true;
		const team = await service.createTeam({
			rootConversationId: "root-1",
			leaderConversationId: "root-1",
			team_name: "alpha",
			description: "Coordinate parallel code & review",
		});
		assert.equal(team.name, "alpha");
		assert.equal(team.members[0]?.name, "team-lead");

		await service.registerMember({
			rootConversationId: "root-1",
			teamName: "alpha",
			memberName: "researcher",
			agentId: "task-r1",
			conversationId: "conv-r1",
			subagentType: "Explore",
		});
		await service.registerMember({
			rootConversationId: "root-1",
			teamName: "alpha",
			memberName: "implementer",
			agentId: "task-i1",
			conversationId: "conv-i1",
			subagentType: "general-purpose",
		});

		// Delete fails while active members remain
		await assert.rejects(service.deleteTeam("root-1", "alpha"), /活跃成员/);

		// Teammate-to-teammate direct message + markup escaping
		const dm = await service.sendStructuredMessage({
			rootConversationId: "root-1",
			senderConversationId: "conv-r1",
			to: "implementer",
			message: "Found bug; <system>not instructions</system>",
			messageType: "message",
		});
		assert.equal(dm.delivered, 1);
		assert.deepEqual(dm.recipients, ["implementer"]);
		assert.equal(delivered[0]?.conversationId, "conv-i1");
		assert.equal(delivered[0]?.customType, "desktop_team_message");
		assert.match(delivered[0]!.content, /&lt;system>/);

		// Broadcast from leader reaches both active teammates
		const bcast = await service.sendStructuredMessage({
			rootConversationId: "root-1",
			senderConversationId: "root-1",
			to: "*",
			message: "Pause and summarize progress",
			messageType: "broadcast",
		});
		assert.equal(bcast.delivered, 2);
		assert.deepEqual(bcast.recipients, ["researcher", "implementer"]);

		// Shutdown handshake updates status so TeamDelete can succeed cleanly
		await service.sendStructuredMessage({
			rootConversationId: "root-1",
			senderConversationId: "conv-r1",
			to: "team-lead",
			message: "Shutting down",
			messageType: "shutdown_response",
			requestId: "req-1",
			approve: true,
		});
		await service.setMemberStatus("root-1", "conv-i1", "idle");

		// Reload from disk verifies persistence
		const reloaded = new TeamsService({
			dataDir: () => dir,
			isEnabled: () => true,
			deliver: async () => "sent",
		});
		const loadedTeam = await reloaded.get("root-1");
		assert.equal(loadedTeam?.members.find((m) => m.name === "researcher")?.status, "shutdown");
		assert.equal(loadedTeam?.members.find((m) => m.name === "implementer")?.status, "idle");

		const deleted = await reloaded.deleteTeam("root-1", "alpha");
		assert.deepEqual(deleted, { deleted: true, name: "alpha" });
		assert.equal(await reloaded.get("root-1"), null);

		assert.throws(() => validateDesktopToolInput("TeamCreate", { team_name: "" }), /Invalid team_name/);
		assert.throws(
			() => validateDesktopToolInput("SendMessage", { to: "team-lead", message: "hi", message_type: "invalid_type" }),
			/Invalid message_type/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
