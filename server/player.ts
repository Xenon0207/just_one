import JsonRpc from "https://deno.land/x/json_rpc@v1.0.0/mod.ts";
import Game from "./game.ts";

export default class Player {
	name = "";
	key = Math.random().toString().replace(/\D/g, "");
	game: Game | null = null;
	jsonrpc: JsonRpc;
	
	// Game state specific to player
	isGuesser = false;
	hasVotedSkip = false;
	clue: string | null = null;
	clueValid: boolean | null = null;
	votedDuplicatePairs: Record<string, boolean> = {};

	constructor(ws: WebSocket) {
		const io = {
			sendData(str: string) { try { ws.send(str); } catch (e) {} },
			onData(_str: string) {}
		}
		let jsonrpc = new JsonRpc(io);
		this.jsonrpc = jsonrpc;

		this._exposeInterface(jsonrpc);

		ws.addEventListener("message", e => io.onData(e.data));
		ws.addEventListener("close", () => {
			const { game } = this;
			this._log("disconnected");
			if (game) { game.removePlayer(this); }
		});
	}

	toJSON() {
		return {
			name: this.name,
			isGuesser: this.isGuesser,
			hasVotedSkip: this.hasVotedSkip,
			clue: this.clue,
			clueValid: this.clueValid,
			votedDuplicatePairs: this.votedDuplicatePairs
		};
	}

	_log(msg: string, ...args: unknown[]) {
		return console.log(`[player ${this.name || 'unknown'}] ${msg}`, ...args);
	}

	_exposeInterface(jsonrpc: JsonRpc) {
		// Lobby setup
		jsonrpc.expose("create-game", (gameName: string, playerName: string) => {
			this.name = playerName;
			this.game = new Game(gameName, this);
			return this.key;
		});

		jsonrpc.expose("join-game", (gameName: string, playerName: string) => {
			const game = Game.find(gameName);
			if (!game) { throw new Error(`Game "${gameName}" does not exist`); }

			this.name = playerName;
			this._log("joined game", gameName);
			game.addPlayer(this);
			return this.key;
		});

		jsonrpc.expose("start-game", () => {
			const game = this.game;
			if (!game) { throw new Error("Cannot start a non-joined game"); }
			if (game.owner != this) { throw new Error("Only the game owner can start it"); }
			this._log("starting the game");
			game.start();
		});

		jsonrpc.expose("quit-game", () => {
			const game = this.game;
			if (!game) { throw new Error("Cannot quit a non-joined game"); }
			this._log("left the game");
			game.removePlayer(this);
		});

		jsonrpc.expose("game-info", () => {
			const game = this.game;
			return (game ? game.getInfo(this) : null);
		});
		jsonrpc.expose("vote-skip", () => {
			if (!this.game) throw new Error("Not in game");
			this.game.voteSkip(this);
		});

		jsonrpc.expose("submit-clue", (clue: string) => {
			if (!this.game) throw new Error("Not in game");
			this.game.submitClue(this, clue);
		});

		jsonrpc.expose("vote-duplicate", (pairId: string, keep: boolean) => {
			if (!this.game) throw new Error("Not in game");
			this.game.voteDuplicate(this, pairId, keep);
		});

		jsonrpc.expose("submit-guess", (guess: string) => {
			if (!this.game) throw new Error("Not in game");
			this.game.submitGuess(this, guess);
		});
	}
}
