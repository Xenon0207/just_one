import { serveFile } from "jsr:@std/http/file-server";
import Player from "./player.ts";

async function handleReq(req: Request, conn: Deno.ServeHandlerInfo) {
	const remoteAddress = "hostname" in conn.remoteAddr
		? conn.remoteAddr.hostname
		: "path" in conn.remoteAddr
			? conn.remoteAddr.path
			: `${conn.remoteAddr.cid}:${conn.remoteAddr.port}`;
	console.log("new http request", req.url, req.headers.get("x-real-ip") || remoteAddress);
	
	if (req.url.endsWith("/debug-headers")) {
		let hdrs = "";
		req.headers.forEach((v, k) => hdrs += `${k}: ${v}\n`);
		return new Response(hdrs, { status: 200 });
	}

	// Upgrade to WebSocket if requested
	const upgrade = req.headers.get("upgrade") || "";
	if (upgrade.toLowerCase() === "websocket" || req.url.endsWith("/ws")) {
		try {
			const { socket, response } = Deno.upgradeWebSocket(req);
			console.log("accepted websocket upgrade");
			new Player(socket);
			return response;
		} catch (e) {
			console.error("failed to accept websocket", e);
			return new Response("Websocket upgrade failed", { status: 400 });
		}
	}

	// Otherwise serve static files from the project root
	try {
		const url = new URL(req.url);
		let filepath = url.pathname;
		if (filepath === "/") filepath = "/index.html";
		
		// Remove leading slash for local path resolution
		filepath = filepath.substring(1);
		
		return await serveFile(req, filepath);
	} catch (e) {
		console.error("failed to serve file", e);
		return new Response(`Not Found. URL: ${req.url}, Upgrade: ${req.headers.get("upgrade")}`, { status: 404 });
	}
}

const port = Number(Deno.args[0] || "8080");
console.log(`Server listening on http://localhost:${port}`);
Deno.serve({ port }, handleReq);
