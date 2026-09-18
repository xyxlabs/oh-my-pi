import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import {
	computeNonMessageTokens,
	computeNonMessageBreakdown,
	estimateToolSchemaTokens,
	invalidateToolSchemaMetadata,
} from "@oh-my-pi/pi-tui/status-line/context-usage";

function fixtureTool(): AgentTool {
	return {
		name: "inspect",
		label: "Inspect",
		description: "Detailed tool instructions. ".repeat(60),
		parameters: type({ "query /** A precise search query. */": "string" }) as unknown as AgentTool["parameters"],
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
}

async function withToolEnvironment(run: () => Promise<void>): Promise<void> {
	const previousDialect = Bun.env.PI_DIALECT;
	const previousIntent = Bun.env.PI_NO_INTENT;
	delete Bun.env.PI_DIALECT;
	delete Bun.env.PI_NO_INTENT;
	try {
		await run();
	} finally {
		if (previousDialect === undefined) delete Bun.env.PI_DIALECT;
		else Bun.env.PI_DIALECT = previousDialect;
		if (previousIntent === undefined) delete Bun.env.PI_NO_INTENT;
		else Bun.env.PI_NO_INTENT = previousIntent;
	}
}

describe("normalized request accounting", () => {
	for (const mode of ["native", "inlined", "owned"] as const) {
		it(`counts ${mode} tools like the prepared request without changing executable tools`, async () => {
			await withToolEnvironment(async () => {
				const tool = fixtureTool();
				const agent = new Agent({
					initialState: {
						model: createMockModel({ responses: [] }),
						tools: [tool],
						systemPrompt: [tool.description],
					},
					intentTracing: true,
					pruneToolDescriptions: mode === "inlined",
					...(mode === "owned" ? { dialect: "glm" as const } : {}),
				});
				const source = { systemPrompt: agent.state.systemPrompt, agent };
				const prepared = await agent.buildSideRequestContext([]);
				const expectedTools = estimateToolSchemaTokens(prepared.tools ?? [], agent.tokenizer);
				expect(computeNonMessageTokens(source, agent.tokenizer)).toBe(
					agent.tokenizer.countTokens(prepared.systemPrompt ?? []) + expectedTools,
				);
				expect(computeNonMessageBreakdown(source, agent.tokenizer).toolsTokens).toBe(expectedTools);
				expect(agent.state.tools[0]).toBe(tool);
				expect(tool.description).toContain("Detailed tool instructions.");
				if (mode === "inlined")
					expect(expectedTools).toBeLessThan(estimateToolSchemaTokens(agent.state.tools, agent.tokenizer));
				if (mode === "owned") expect(expectedTools).toBe(0);
			});
		});
	}

	it("refreshes estimates after live metadata, settings revisions and tool replacement", async () => {
		await withToolEnvironment(async () => {
			let description = "short";
			let reads = 0;
			const tool = fixtureTool();
			Object.defineProperty(tool, "description", {
				get: () => {
					reads++;
					return description;
				},
			});
			const agent = new Agent({
				initialState: { model: createMockModel({ responses: [] }), tools: [tool], systemPrompt: ["base"] },
			});
			const source = { systemPrompt: agent.state.systemPrompt, agent };
			const first = computeNonMessageTokens(source, agent.tokenizer);
			const readCount = reads;
			expect(computeNonMessageTokens(source, agent.tokenizer)).toBe(first);
			expect(reads).toBe(readCount);
			description = "Expanded instructions. ".repeat(40);
			invalidateToolSchemaMetadata(agent.state.tools);
			const expanded = computeNonMessageTokens(source, agent.tokenizer);
			expect(expanded).toBeGreaterThan(first);
			description = "updated";
			expect(computeNonMessageTokens(source, agent.tokenizer, 1)).toBeLessThan(expanded);
			agent.setTools([]);
			expect(computeNonMessageTokens(source, agent.tokenizer, 1)).toBe(
				agent.tokenizer.countTokens(source.systemPrompt),
			);
		});
	});

	it("updates native intent and owned-dialect estimates without changing the tool registry", async () => {
		await withToolEnvironment(async () => {
			const agent = new Agent({
				initialState: { model: createMockModel({ responses: [] }), tools: [fixtureTool()], systemPrompt: ["base"] },
				intentTracing: true,
			});
			const source = { systemPrompt: agent.state.systemPrompt, agent };
			const native = computeNonMessageTokens(source, agent.tokenizer);
			Bun.env.PI_NO_INTENT = "1";
			expect(computeNonMessageTokens(source, agent.tokenizer)).toBeLessThan(native);
			Bun.env.PI_DIALECT = "glm";
			expect(computeNonMessageTokens(source, agent.tokenizer)).toBe(
				agent.tokenizer.countTokens(source.systemPrompt),
			);
		});
	});
});

it("updates mounted provider tools in the count when the model changes", async () => {
	await withToolEnvironment(async () => {
		const model = createMockModel({ responses: [] });
		const mounted = { ...fixtureTool(), name: "mcp__fixture__inspect" };
		const agent = new Agent({
			initialState: { model, tools: [fixtureTool()], systemPrompt: ["base"] },
			getCursorTools: () => [mounted],
		});
		const source = { systemPrompt: agent.state.systemPrompt, agent };
		const before = computeNonMessageTokens(source, agent.tokenizer);
		agent.setModel({ ...model, api: "cursor-agent", provider: "cursor" });
		const context = await agent.buildSideRequestContext([]);
		expect(context.tools?.map(tool => tool.name)).toContain(mounted.name);
		expect(computeNonMessageTokens(source, agent.tokenizer)).toBe(
			agent.tokenizer.countTokens(source.systemPrompt) +
				estimateToolSchemaTokens(context.tools ?? [], agent.tokenizer),
		);
		expect(computeNonMessageTokens(source, agent.tokenizer)).toBeGreaterThan(before);
		agent.setModel(model);
		expect(computeNonMessageTokens(source, agent.tokenizer)).toBe(before);
	});
});
