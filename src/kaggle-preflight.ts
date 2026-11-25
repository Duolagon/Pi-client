const sourceFields = ["dataset_sources", "kernel_sources", "model_sources", "competition_sources"] as const;

/** Local diagnostics for a Kaggle CLI metadata file. Platform and account state can differ. */
export function inspectKaggleMetadata(raw: string) {
	const value: unknown = JSON.parse(raw);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("应提供 kernel-metadata.json 文件。");
	const metadata = value as Record<string, unknown>;
	const warnings: string[] = [];
	const flag = (name: string) => {
		const value = metadata[name];
		if (value === true || value === "true") return true;
		if (value === undefined || value === false || value === "false") return false;
		warnings.push(`${name} 需要是 true 或 false。`);
	};
	const gpu = flag("enable_gpu");
	const internet = flag("enable_internet");
	const accelerator = typeof metadata.machine_shape === "string" && metadata.machine_shape.trim() || undefined;
	if (typeof metadata.code_file !== "string" || !metadata.code_file.trim()) warnings.push("缺少 code_file，请指定 Notebook 或脚本文件。");
	if ((typeof metadata.id !== "string" || !metadata.id.includes("/")) &&
		(typeof metadata.id_no !== "number" || !Number.isSafeInteger(metadata.id_no) || metadata.id_no < 1))
		warnings.push("缺少 Notebook 的 owner/slug 或有效数字 ID。");
	const sources = Object.fromEntries(sourceFields.map((field) => {
		const refs = metadata[field];
		if (refs !== undefined && (!Array.isArray(refs) || refs.some((item) => typeof item !== "string" || !item.trim())))
			warnings.push(`${field} 需要是资源标识列表。`);
		return [field, Array.isArray(refs) ? refs.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : []] as const;
	}));
	if (gpu === true && !accelerator) warnings.push("已请求 GPU，未指定加速器型号。请在 Kaggle 核对实际分配。");
	if (gpu === false && accelerator && /nvidia|gpu/i.test(accelerator))
		warnings.push("指定了 GPU 型号，但 enable_gpu 未开启。");
	if (internet === true && sources.competition_sources.includes("gemma-4-developer-agent") &&
		accelerator && /^nvidiaL4x4$/i.test(accelerator))
		warnings.push("这场比赛的 L4×4 会话曾拒绝开启网络。请在 Kaggle 核对并准备离线依赖。");
	if (internet === false && !sources.dataset_sources.length && !sources.kernel_sources.length && !sources.model_sources.length)
		warnings.push("已禁用网络，且未声明数据集、上游 Notebook 或模型资源。若运行依赖外部文件，请先挂载。");
	return { gpu, internet, accelerator, sources, warnings };
}
