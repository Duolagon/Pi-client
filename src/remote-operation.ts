/** Known remote writes through Kaggle's CLI and direct HTTP endpoints. This is command classification, not a shell sandbox. */
const kaggleWrites = new Map([
	["kernels", new Set(["push", "delete", "cancel", "stop"])],
	["datasets", new Set(["create", "version", "delete", "update"])],
	["competitions", new Set(["submit", "join", "leave", "accept-rules"])],
	["models", new Set(["create", "delete", "update"])],
	["model-instances", new Set(["create", "delete", "update"])],
	["model-instance-versions", new Set(["create", "delete", "update"])],
]);
const cliAliases = new Map([["k", "kernels"], ["d", "datasets"], ["c", "competitions"], ["m", "models"]]);

const remoteService = "(?:kernel|dataset|competition|model)[a-z.-]*";
const legacyAction = new RegExp(`^/api/v[0-9]+/${remoteService}/(?:push|delete|create|version|update|cancel|stop|submit|join|leave|accept-rules)(?:/|$)`, "i");
const remoteResource = new RegExp(`^/api/v[0-9]+/${remoteService}(?:/|$)`, "i");
const rpcAction = new RegExp(`^/api/i/${remoteService}/(?:push|delete|create|update|cancel|stop|submit|join|leave|accept)[a-z]*(?:/|$)`, "i");

export function knownRemoteOperation(argv: string[]): string | undefined {
	const executable = argv[0]?.split("/").at(-1)?.replace(/\.exe$/i, "");
	const args = argv.slice(1);
	if (executable === "kaggle") {
		const [command, action] = args.filter((word) => !word.startsWith("-"));
		const resource = cliAliases.get(command) ?? command;
		if (kaggleWrites.get(resource)?.has(action) && !args.some((word) => word === "--help" || word === "-h"))
			return `Kaggle ${resource} ${action}`;
	}
	if (executable !== "curl") return;
	let mutatingMethod = false;
	let resourceMethod = false;
	let postBody = false;
	let get = false;
	for (let i = 0; i < args.length; i++) {
		const word = args[i];
		const method = word === "-X" || word === "--request" ? args[++i] : /^(?:-X|--request=)(.+)$/.exec(word)?.[1];
		if (method && /^(?:POST|PUT|PATCH|DELETE)$/i.test(method)) mutatingMethod = true;
		if (method && /^(?:PUT|PATCH|DELETE)$/i.test(method)) resourceMethod = true;
		if (/^(?:-[dDFT]|--(?:data(?:-raw|-binary|-urlencode|-ascii)?|form(?:-string)?|json|upload-file)(?:=|$))/.test(word)) postBody = true;
		if (word === "-G" || word === "--get") get = true;
	}
	if (!mutatingMethod && (!postBody || get)) return;
	for (const word of args) {
		if (!/^https?:\/\//i.test(word)) continue;
		let url: URL;
		try { url = new URL(word); } catch { continue; }
		if (url.hostname !== "www.kaggle.com" && url.hostname !== "kaggle.com" && url.hostname !== "api.kaggle.com") continue;
		if (legacyAction.test(url.pathname) || rpcAction.test(url.pathname) || (resourceMethod && remoteResource.test(url.pathname)))
			return "Kaggle API";
	}
}

const statusClauses = [
	/^为(?:啥|什么)(?:要|还在|还要|一直在)?排队了?呢?$/u,
	/^(?:(?:我们|这个任务|比赛|kaggle)\s*)?(?:(?:现在|当前|目前)\s*)?(?:在跑什么|在运行什么|什么状态|什么情况|什么进展|怎么样|进度如何|进展如何|跑到哪(?:儿|里)?|有没有出分)了?[呢吗]?$/u,
	/^(?:(?:现在|当前|目前)\s*)?(?:跑完|排到|出分)了吗$/u,
	/^(?:请\s*)?(?:帮我\s*)?(?:查(?:一)?下|查看|看(?:一)?下|只查(?:一)?下)\s*(?:(?:当前|现在|kaggle)\s*){0,2}(?:(?:任务|作业|队列|notebook)\s*的?\s*)?(?:运行)?(?:状态|进度|进展)$/u,
	/^what(?:'s| is) (?:running(?: now)?|the (?:current |queue |job |task )?status)$/,
	/^why (?:is (?:it|the job) queued|(?:is it |are we )waiting)$/,
	/^(?:how(?:'s| is) (?:it|the (?:job|task)) going|any (?:progress|updates?))$/,
	/^(?:check|show) (?:me )?(?:the )?(?:current |kaggle |queue |job |task ){0,3}(?:status|progress)$/,
	/^status(?: only)?$/,
];

/** Classify only standalone status questions. A separate clause granting an action is not read-only intent. */
export function isStatusOnlyRequest(message: string): boolean {
	if (message.length > 200) return false;
	const clauses = message.trim().toLowerCase().split(/[\r\n，,。！？?!；;]+/u).map((clause) => clause.trim()).filter(Boolean);
	return clauses.length > 0 && clauses.every((clause) => statusClauses.some((pattern) => pattern.test(clause)));
}
