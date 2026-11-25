import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectKaggleMetadata } from "../src/kaggle-preflight.ts";

test("reads Kaggle CLI metadata booleans and flags the observed L4 and Internet conflict", () => {
	const input = {
		id: "sample/experiment",
		code_file: "experiment.ipynb",
		enable_gpu: "true",
		enable_internet: true,
		machine_shape: "NvidiaL4x4",
		competition_sources: ["gemma-4-developer-agent"],
		kernel_sources: ["sample/wheels"],
	};
	const result = inspectKaggleMetadata(JSON.stringify(input));
	assert.equal(result.gpu, true);
	assert.equal(result.internet, true);
	assert.deepEqual(result.sources.kernel_sources, ["sample/wheels"]);
	assert.match(result.warnings[0], /曾拒绝开启网络/);
	assert.deepEqual(inspectKaggleMetadata(JSON.stringify({ ...input, enable_internet: false })).warnings, []);
});

test("offline runtime preflight reports malformed config and undeclared assets without executing the notebook", () => {
	const report = inspectKaggleMetadata(JSON.stringify({ id_no: 42, enable_gpu: true, model_sources: "sample/model" }));
	assert.equal(report.internet, false);
	assert.match(report.warnings.join("\n"), /code_file/);
	assert.match(report.warnings.join("\n"), /未指定加速器/);
	assert.match(report.warnings.join("\n"), /未声明/);
	assert.throws(() => inspectKaggleMetadata("[]"), /kernel-metadata/);
});
