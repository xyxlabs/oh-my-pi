import { afterEach, expect, it, vi } from "bun:test";
import { Settings } from "../src/config/settings";
import type { ModelRegistry } from "../src/config/model-registry";
import { resolveJudge } from "../src/judgment";
import { ONLINE_MEMORY_MODEL_KEY } from "../src/tiny/models";
import { asGlobalFetch } from "./helpers/fetch-mock";
afterEach(() => vi.restoreAllMocks());
it("disabled TypeSafe credentials are not used by new or already-resolved judges", async () => {
	const settings = Settings.isolated({ "providers.judgmentProvider": "typesafe" });
	const registry = {
		authStorage: { hasAuth: () => true, resolver: () => async () => "fixture" },
	} as unknown as ModelRegistry;
	const native = resolveJudge({ settings, registry, backend: ONLINE_MEMORY_MODEL_KEY });
	settings.set("disabledProviders", ["typesafe"]);
	const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(
		asGlobalFetch(async () =>
			Response.json({
				model: "jev-1.13.0",
				answers: { ok: { type: "noul", noul: 1 } },
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
		),
	);
	await expect(
		native.judge({ state: "private", questions: { ok: { type: "noul", instructions: "ok?" } } }),
	).rejects.toThrow(/disabled/);
	expect(fetcher).not.toHaveBeenCalled();
	expect(resolveJudge({ settings, registry, backend: ONLINE_MEMORY_MODEL_KEY }).kind).not.toBe("typesafe");
});
