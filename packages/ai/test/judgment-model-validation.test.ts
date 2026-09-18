import { describe, expect, it } from "bun:test";
import { TypeSafeJudge } from "../src/judgment/typesafe";

const request = {
	state: "Validate the route",
	questions: { ok: { type: "noul", instructions: "Is this valid?" } },
} as const;
function judge(model: string, returned: unknown) {
	return new TypeSafeJudge({
		apiKey: "fixture",
		model,
		fetch: async () =>
			Response.json({
				model: returned,
				answers: { ok: { type: "noul", noul: 1 } },
				usage: { input_tokens: 2, output_tokens: 1 },
			}),
	});
}
describe("TypeSafe response model identity", () => {
	it("rejects a response from a different pinned model", async () => {
		await expect(judge("jev-1.13.0", "jev-1.12.0").judge(request)).rejects.toThrow(/model/);
	});
	it("rejects unresolved or foreign rolling alias responses", async () => {
		await expect(judge("jev-latest", "jev-latest").judge(request)).rejects.toThrow(/model/);
		await expect(judge("jev-preview", "foreign-1.0.0").judge(request)).rejects.toThrow(/model/);
	});
	it("accepts a concrete model resolved from either rolling alias", async () => {
		for (const alias of ["jev-latest", "jev-preview"])
			expect((await judge(alias, "jev-1.13.0").judge(request)).model).toBe("jev-1.13.0");
	});
});
