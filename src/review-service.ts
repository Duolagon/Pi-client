import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PullRequestStatus } from "./shared.ts";

const exec = promisify(execFile);
const fields = "number,title,url,state,isDraft,headRefName,baseRefName,reviewDecision,statusCheckRollup";

export async function readPullRequest(
	cwd: string,
	env?: NodeJS.ProcessEnv,
	number?: number,
): Promise<PullRequestStatus | null> {
	try {
		const { stdout } = await exec("gh", ["pr", "view", ...(number === undefined ? [] : [String(number)]), "--json", fields], {
			cwd,
			env: { ...process.env, ...env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" },
			timeout: 12000,
			maxBuffer: 1024 * 1024,
		});
		const pr = JSON.parse(stdout) as Omit<PullRequestStatus, "checks"> & {
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
