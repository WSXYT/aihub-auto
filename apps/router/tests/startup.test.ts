import { describe, expect, test } from "bun:test";
import { ConfigSchema } from "../src/config.ts";
import {
	applyStartupOptions,
	parseStartupOptions,
	STARTUP_HELP,
} from "../src/startup.ts";

describe("startup options", () => {
	test.each([
		[["--port", "9000"], {}, 9000],
		[["--port=9001"], {}, 9001],
		[[], { AIHUB_AUTO_PORT: "9002" }, 9002],
		[["--port", "9003"], { AIHUB_AUTO_PORT: "9004" }, 9003],
	] as const)("args=%j env=%j selects %i", (args, env, port) => {
		expect(parseStartupOptions([...args], env).port).toBe(port);
	});

	test.each(["0", "65536", "1.5", " 9000", "9000 ", "+9000", "09x"])(
		"rejects invalid environment port %s",
		(value) => {
			expect(() =>
				parseStartupOptions([], { AIHUB_AUTO_PORT: value }),
			).toThrow(/AIHUB_AUTO_PORT.*1.*65535/);
		},
	);

	test.each([
		["missing value", ["--port"]],
		["duplicate", ["--port=9000", "--port", "9001"]],
		["unknown", ["--listen", "9000"]],
	] as const)("rejects %s", (_name, args) => {
		expect(() => parseStartupOptions([...args], {})).toThrow();
	});

	test("help does not require a port and describes precedence", () => {
		expect(parseStartupOptions(["--help"], {}).help).toBe(true);
		expect(STARTUP_HELP).toContain("--port");
		expect(STARTUP_HELP).toContain("AIHUB_AUTO_PORT");
	});

	test("override changes memory but leaves the loaded object unchanged", () => {
		const loaded = ConfigSchema.parse({ listen: { port: 8123 } });
		const effective = applyStartupOptions(loaded, {
			help: false,
			port: 9123,
		});
		expect(effective.listen.port).toBe(9123);
		expect(loaded.listen.port).toBe(8123);
	});

	test("accepts the supported 9-character console password", () => {
		expect(ConfigSchema.parse({ uiPassword: "Qazwsx01@" }).uiPassword).toBe(
			"Qazwsx01@",
		);
	});

	test("rejects console passwords shorter than 9 characters", () => {
		expect(() => ConfigSchema.parse({ uiPassword: "12345678" })).toThrow();
	});
});
