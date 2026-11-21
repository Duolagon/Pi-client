import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PullRequestComment, PullRequestMergeMethod, PullRequestStatus } from "./shared.ts";

const exec = promisify(execFile);
const fields = "number,title,url,state,isDraft,headRefName,baseRefName,reviewDecision,autoMergeRequest,statusCheckRollup";

function ghEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return { ...process.env, ...env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" };
}

function assertPrNumber(number: number): void {
	if (!Number.isSafeInteger(number) || number < 1) throw new Error("PR 编号无效。");
}

function sanitizeHttpsUrl(raw?: string): string | undefined {
	if (!raw) return undefined;
	try {
		const url = new URL(raw);
		if (url.protocol !== "https:" || url.username || url.password) return undefined;
		return url.href;
	} catch {
		return undefined;
	}
}

export async function readPullRequest(
	cwd: string,
	env?: NodeJS.ProcessEnv,
	number?: number,
): Promise<PullRequestStatus | null> {
	if (number !== undefined) assertPrNumber(number);
	try {
		const { stdout } = await exec("gh", ["pr", "view", ...(number === undefined ? [] : [String(number)]), "--json", fields], {
			cwd,
			env: ghEnv(env),
			timeout: 12000,
			maxBuffer: 1024 * 1024,
		});
		const pr = JSON.parse(stdout) as Omit<PullRequestStatus, "checks" | "autoMerge"> & {
			autoMergeRequest?: { enabledAt?: string; mergeMethod?: string } | null;
			statusCheckRollup?: Array<{ name?: string; context?: string; status?: string; conclusion?: string; state?: string }>;
		};
		const url = new URL(pr.url);
		if (url.protocol !== "https:" || url.username || url.password) throw new Error("PR 地址无效。");
		return {
			number: pr.number,
			title: pr.title,
			url: url.href,
			state: pr.state,
			isDraft: pr.isDraft,
			headRefName: pr.headRefName,
			baseRefName: pr.baseRefName,
			reviewDecision: pr.reviewDecision,
			autoMerge: pr.autoMergeRequest ? { enabled: true, mergeMethod: pr.autoMergeRequest.mergeMethod } : { enabled: false },
			checks: (pr.statusCheckRollup ?? []).slice(0, 100).map((check) => ({
				name: check.name ?? check.context ?? "CI",
				status: check.conclusion || check.state || check.status || "UNKNOWN",
			})),
		};
	} catch (error) {
		const failure = error as NodeJS.ErrnoException & { stderr?: string };
		if (failure.code === "ENOENT") throw new Error("需要安装并登录 GitHub CLI（gh）才能读取 PR 和 CI 状态。");
		if (number === undefined && /no pull requests? found/i.test(failure.stderr ?? "")) return null;
		throw new Error(failure.stderr?.trim().slice(0, 800) || failure.message);
	}
}

export async function setPullRequestAutoMerge(
	cwd: string,
	number: number,
	enabled: boolean,
	method: PullRequestMergeMethod = "squash",
	env?: NodeJS.ProcessEnv,
): Promise<PullRequestStatus | null> {
	assertPrNumber(number);
	const args = enabled
		? ["pr", "merge", String(number), "--auto", method === "rebase" ? "--rebase" : method === "merge" ? "--merge" : "--squash"]
		: ["pr", "merge", String(number), "--disable-auto"];
	try {
		await exec("gh", args, {
			cwd,
			env: ghEnv(env),
			timeout: 20000,
			maxBuffer: 256 * 1024,
		});
	} catch (error) {
		const failure = error as NodeJS.ErrnoException & { stderr?: string };
		if (failure.code === "ENOENT") throw new Error("需要安装并登录 GitHub CLI（gh）。");
		throw new Error(failure.stderr?.trim().slice(0, 800) || failure.message);
	}
	return readPullRequest(cwd, env, number);
}

export async function readPullRequestComments(
	cwd: string,
	number: number,
	env?: NodeJS.ProcessEnv,
): Promise<PullRequestComment[]> {
	assertPrNumber(number);
	const cliEnv = ghEnv(env);
	const comments: PullRequestComment[] = [];
	try {
		const { stdout } = await exec("gh", ["pr", "view", String(number), "--json", "comments,reviews"], {
			cwd,
			env: cliEnv,
			timeout: 15000,
			maxBuffer: 2 * 1024 * 1024,
		});
		const parsed = JSON.parse(stdout) as {
			comments?: Array<{ id?: string; author?: { login?: string }; body?: string; createdAt?: string; url?: string }>;
			reviews?: Array<{ id?: string; author?: { login?: string }; body?: string; state?: string; submittedAt?: string; url?: string }>;
		};
		for (const item of parsed.comments ?? []) {
			const body = (item.body ?? "").trim();
			if (!body) continue;
			comments.push({
				id: String(item.id ?? `issue-${comments.length + 1}`),
				author: item.author?.login || "unknown",
				body: body.slice(0, 4000),
				createdAt: item.createdAt || "",
				kind: "issue",
				url: sanitizeHttpsUrl(item.url),
			});
		}
		for (const review of parsed.reviews ?? []) {
			const body = (review.body ?? "").trim();
			if (!body) continue;
			comments.push({
				id: String(review.id ?? `review-${comments.length + 1}`),
				author: review.author?.login || "unknown",
				body: body.slice(0, 4000),
				createdAt: review.submittedAt || "",
				kind: "review",
				state: review.state,
				url: sanitizeHttpsUrl(review.url),
			});
		}
	} catch (error) {
		const failure = error as NodeJS.ErrnoException & { stderr?: string };
		if (failure.code === "ENOENT") throw new Error("需要安装并登录 GitHub CLI（gh）才能拉取 PR 评论。");
		throw new Error(failure.stderr?.trim().slice(0, 800) || failure.message);
	}

	// Best-effort fetch of inline line-level review comments via GitHub REST API.
	try {
		const { stdout } = await exec(
			"gh",
			["api", `repos/{owner}/{repo}/pulls/${number}/comments`, "--paginate"],
			{ cwd, env: cliEnv, timeout: 15000, maxBuffer: 2 * 1024 * 1024 },
		);
		const inlineItems = JSON.parse(stdout) as Array<{
			id?: number | string;
			user?: { login?: string };
			body?: string;
			path?: string;
			line?: number | null;
			original_line?: number | null;
			created_at?: string;
			html_url?: string;
		}>;
		if (Array.isArray(inlineItems)) {
			for (const item of inlineItems) {
				const body = (item.body ?? "").trim();
				if (!body) continue;
				const line = typeof item.line === "number" ? item.line : typeof item.original_line === "number" ? item.original_line : undefined;
				comments.push({
					id: `inline-${item.id ?? comments.length + 1}`,
					author: item.user?.login || "unknown",
					body: body.slice(0, 4000),
					createdAt: item.created_at || "",
					kind: "inline",
					path: item.path || undefined,
					line,
					url: sanitizeHttpsUrl(item.html_url),
				});
			}
		}
	} catch {
		// Inline comment lookup is best-effort; keep issue & review comments.
	}

	comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	return comments.slice(0, 200);
}

export { formatPullRequestCommentsPrompt } from "./shared.ts";

export interface DraftPullRequest {
	branch: string;
	base?: string;
	title: string;
	body: string;
}

export async function createDraftPullRequest(cwd: string, draft: DraftPullRequest, env?: NodeJS.ProcessEnv): Promise<{ url: string; number: number }> {
	const cliEnv = { ...process.env, ...env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" };
	const { stdout: ref } = await exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd, env: cliEnv, timeout: 3000 });
	if (ref.trim() !== draft.branch || !draft.title.trim()) throw new Error("分支或标题已变更，请刷新后重试。");
	try {
		// An explicit head makes gh use an existing remote branch without pushing a local branch.
		const { stdout } = await exec("gh", [
			"pr", "create", "--draft", `--head=${draft.branch}`, `--title=${draft.title}`, `--body=${draft.body}`,
			...(draft.base ? [`--base=${draft.base}`] : []),
		], { cwd, env: cliEnv, timeout: 20000, maxBuffer: 256 * 1024 });
		const url = new URL(stdout.trim().split(/\r?\n/).at(-1)!);
		const number = Number(/\/pull\/(\d+)\/?$/.exec(url.pathname)?.[1]);
		if (url.protocol !== "https:" || url.username || url.password || !Number.isSafeInteger(number) || number < 1)
			throw new Error("GitHub 返回的草稿 PR 地址无效，请刷新状态。");
		return { url: url.href, number };
	} catch (error) {
		const failure = error as NodeJS.ErrnoException & { stderr?: string };
		if (failure.code === "ENOENT") throw new Error("需要安装并登录 GitHub CLI（gh）。");
		throw new Error(failure.stderr?.trim().slice(0, 800) || failure.message);
	}
}
