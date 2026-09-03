import JsonRpc from "../src/client/json-rpc.ts";

Deno.test("disconnect rejects pending calls instead of leaving buttons waiting", async () => {
	const io = { onData(_data: string) {}, sendData(_data: string) {} };
	const rpc = new JsonRpc(io);
	const result = rpc.call("return-to-lobby", []).then(() => false, () => true);
	rpc.disconnect();
	if (!await result || rpc._pendingPromises.size) throw new Error("Pending call was not cleared");
});

Deno.test("failed send cleans up and late responses are ignored", async () => {
	const io = { onData(_data: string) {}, sendData(_data: string) { throw new Error("Disconnected"); } };
	const rpc = new JsonRpc(io);
	const failed = await rpc.call("return-to-lobby", []).then(() => false, () => true);
	if (!failed || rpc._pendingPromises.size) throw new Error("Failed send was not cleaned up");
	io.onData(JSON.stringify({ jsonrpc: "2.0", id: "expired", result: null }));
});
