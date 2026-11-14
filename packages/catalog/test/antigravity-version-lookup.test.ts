import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import {
	ensureAntigravityVersion,
	getAntigravityPlatform,
	getAntigravityVersion,
} from "@oh-my-pi/pi-catalog/wire/gemini-headers";

const RETRY_WINDOW_MS = 10 * 60_000;
const RECHECK_WINDOW_MS = 60 * 60_000;
// The lookup state is process-wide; every test starts on a fresh clock past any
// backoff an earlier test (or file) left behind.
let clock = Date.now();
const savedVersion = process.env.PI_AI_ANTIGRAVITY_VERSION;

function countingFetch(respond: () => Promise<Response>): { fetcher: FetchImpl; calls: () => number } {
	let calls = 0;
	const fetcher = Object.assign(
		(_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
			calls++;
			return respond();
		},
		{ preconnect: fetch.preconnect },
	);
	return { fetcher, calls: () => calls };
}

function manifest(version: string): Response {
	return new Response(`version: ${version}\npath: Antigravity-${version}.zip\n`);
}

function advance(ms: number): void {
	clock += ms;
	setSystemTime(new Date(clock));
}

describe("ensureAntigravityVersion", () => {
	beforeEach(() => {
		delete process.env.PI_AI_ANTIGRAVITY_VERSION;
		clock += RECHECK_WINDOW_MS * 2;
		setSystemTime(new Date(clock));
	});

	afterEach(() => {
		setSystemTime();
		if (savedVersion === undefined) delete process.env.PI_AI_ANTIGRAVITY_VERSION;
		else process.env.PI_AI_ANTIGRAVITY_VERSION = savedVersion;
	});

	it("does not refetch a failed manifest until the retry window passes", async () => {
		const { fetcher, calls } = countingFetch(async () => new Response("unavailable", { status: 503 }));

		await ensureAntigravityVersion(fetcher);
		await ensureAntigravityVersion(fetcher);
		expect(calls()).toBe(1);

		clock += RETRY_WINDOW_MS + 1;
		setSystemTime(new Date(clock));
		await ensureAntigravityVersion(fetcher);
		expect(calls()).toBe(2);
	});

	it("lets an aborted caller stop waiting without cancelling the shared lookup", async () => {
		const release = Promise.withResolvers<Response>();
		const { fetcher, calls } = countingFetch(() => release.promise);
		const controller = new AbortController();

		const aborted = ensureAntigravityVersion(fetcher, controller.signal);
		let concurrentSettled = false;
		const concurrent = ensureAntigravityVersion(fetcher).then(() => {
			concurrentSettled = true;
		});
		controller.abort();
		await aborted;

		expect(concurrentSettled).toBe(false);
		expect(calls()).toBe(1);

		release.resolve(new Response("unavailable", { status: 503 }));
		await concurrent;
		expect(calls()).toBe(1);
	});

	it("does not refetch a discovered version inside the re-check window", async () => {
		const { fetcher, calls } = countingFetch(async () => manifest("9.1.0"));

		await ensureAntigravityVersion(fetcher);
		expect(getAntigravityVersion()).toBe("9.1.0");
		advance(RECHECK_WINDOW_MS - 1);
		await ensureAntigravityVersion(fetcher);
		expect(calls()).toBe(1);
	});

	it("re-checks the manifest after the window and adopts a newer release", async () => {
		let version = "9.2.0";
		const { fetcher, calls } = countingFetch(async () => manifest(version));

		await ensureAntigravityVersion(fetcher);
		expect(getAntigravityVersion()).toBe("9.2.0");

		version = "9.3.0";
		advance(RECHECK_WINDOW_MS + 1);
		await ensureAntigravityVersion(fetcher);
		expect(calls()).toBe(2);
		expect(getAntigravityVersion()).toBe("9.3.0");
	});

	it("keeps the discovered version while a re-check is in flight and after it fails", async () => {
		await ensureAntigravityVersion(countingFetch(async () => manifest("9.4.0")).fetcher);
		expect(getAntigravityVersion()).toBe("9.4.0");

		advance(RECHECK_WINDOW_MS + 1);
		const release = Promise.withResolvers<Response>();
		const { fetcher, calls } = countingFetch(() => release.promise);
		const recheck = ensureAntigravityVersion(fetcher);
		expect(calls()).toBe(1);
		expect(getAntigravityVersion()).toBe("9.4.0");

		release.resolve(new Response("unavailable", { status: 503 }));
		await recheck;
		expect(getAntigravityVersion()).toBe("9.4.0");

		// A failed re-check backs off like any failed lookup.
		await ensureAntigravityVersion(fetcher);
		expect(calls()).toBe(1);
	});
});

describe("getAntigravityPlatform", () => {
	it("reports the native build shipped for each host OS, not the host arch", () => {
		expect(getAntigravityPlatform("darwin")).toEqual({ os: "darwin", arch: "arm64" });
		expect(getAntigravityPlatform("linux")).toEqual({ os: "linux", arch: "amd64" });
		expect(getAntigravityPlatform("win32")).toEqual({ os: "windows", arch: "amd64" });
	});

	it("falls back to the Linux build on an OS without a native client", () => {
		expect(getAntigravityPlatform("freebsd")).toEqual({ os: "linux", arch: "amd64" });
	});
});
