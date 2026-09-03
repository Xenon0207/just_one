import Game, { collectGarbage } from "./game.ts";
import Player from "./player.ts";
import { Phase } from "../src/rules.ts";

function assert(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message);
}
function equal(actual: unknown, expected: unknown) {
	if (actual === expected) return;
	assert(JSON.stringify(actual) === JSON.stringify(expected), `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}
function throws(fn: () => unknown) {
	let threw = false;
	try { fn(); } catch { threw = true; }
	assert(threw, "Expected rejection");
}
function room(count = 3) {
	const players = Array.from({ length: count }, (_, i) => {
		const p = Object.create(Player.prototype) as Player;
		Object.assign(p, { name: `P${i}`, key: `key-${i}`, game: null, color: "", colorCustomized: false,
			isGuesser: false, hasVotedSkip: false, clue: null, clueValid: null, votedDuplicatePairs: {}, readyForLobby: false,
			jsonrpc: { notify() {} } });
		return p;
	});
	const game = new Game(crypto.randomUUID(), players[0]);
	players.slice(1).forEach(p => game.addPlayer(p));
	return { game, players };
}
function setupRound(game: Game) {
	game.clearTimer();
	game._secretWord = "apple";
	game._advanceClueInput();
	const clues = ["river", "mountain", "cloud", "forest"];
	game._players.filter(p => !p.isGuesser).forEach((p, i) => game.submitClue(p, clues[i % clues.length]));
	if (game.phase === Phase.VOTE_SIMILARITY) game._resolveVoting();
	equal(game.phase, Phase.GUESS);
}

Deno.test("shuffle is per-game and does not reorder player identities", () => {
	const { game, players } = room(4);
	const random = Math.random;
	try {
		Math.random = () => 0;
		game.start();
		equal(game._guesserOrder.map(p => p.name), ["P1", "P2", "P3", "P0"]);
		equal(game._players.map(p => p.name), ["P0", "P1", "P2", "P3"]);
		game._resetToLobby();
		Math.random = () => .999;
		game.start();
		equal(game._guesserOrder.map(p => p.name), players.map(p => p.name));
	} finally { Math.random = random; game.close("destroy"); }
});

Deno.test("disconnect before guesser cannot change displayed or actual guesser", () => {
	const { game, players } = room(4);
	try {
		game.start();
		game.clearTimer();
		// Reproduce the previous array-index bug with a known order.
		game._guesserOrder = [...players];
		game._guesserIndex = 1;
		game._currentGuesser = players[1];
		players.forEach(p => p.isGuesser = p === players[1]);
		game.removePlayer(players[0]);
		equal(game.getInfo(players[1]).guesserName, "P1");
		setupRound(game);
		equal(game.getInfo(players[2]).guesserName, "P1");
		game.submitGuess(players[1], "apple");
		equal(game.phase, Phase.ROUND_END);
		game.advanceAfterRound(game.owner);
		equal(game._currentGuesser?.name, "P2");
	} finally { game.close("destroy"); }
});

Deno.test("correct and incorrect guesses wait for host, keep guesses and clues", async () => {
	const { game, players } = room();
	try {
		game.start();
		for (const guess of ["APPLE", "banana"]) {
			setupRound(game);
			game.submitGuess(game._currentGuesser!, guess);
			const result = game._roundResults.at(-1)!;
			equal(result.guess, guess);
			equal(result.correct, guess === "APPLE");
			equal(result.validClues.length + result.invalidClues.length, 2);
			equal(game._timerInterval, null);
			await new Promise(r => setTimeout(r, 20));
			equal(game.phase, Phase.ROUND_END);
			throws(() => game.advanceAfterRound(players[1]));
			game.advanceAfterRound(game.owner);
		}
	} finally { game.close("destroy"); }
});

Deno.test("pause freezes timer, submissions, votes, guess, next and lobby return", async () => {
	const { game, players } = room();
	try {
		game.start();
		throws(() => game.setPaused(players[1], true));
		game.setPaused(game.owner, true);
		const remaining = game._timerMs;
		await new Promise(r => setTimeout(r, 1100));
		equal(game._timerMs, remaining);
		throws(() => game.voteSkip(players[1]));
		throws(() => game.submitClue(players[1], "river"));
		throws(() => game.voteDuplicate(players[1], "pair", true));
		throws(() => game.submitGuess(game._currentGuesser!, "apple"));
		throws(() => game.advanceAfterRound(game.owner));
		throws(() => game.returnToLobby(players[1]));
		game.setPaused(game.owner, false);
		await new Promise(r => setTimeout(r, 1100));
		assert(game._timerMs < remaining, "Timer resumes");
	} finally { game.close("destroy"); }
});

Deno.test("dictionary option is host-only and does not disable duplicate rules", () => {
	const { game, players } = room();
	try {
		throws(() => game.setDictionaryValidation(players[1], false));
		for (const enabled of [true, false]) {
			game.setDictionaryValidation(game.owner, enabled);
			game.start(); game.clearTimer(); game._secretWord = "apple"; game._advanceClueInput();
			const givers = game._players.filter(p => !p.isGuesser);
			game.submitClue(givers[0], "zzquux");
			const view = game.getInfo(game._currentGuesser!);
			equal(view.players.find(p => p.name === givers[0].name)?.hasSubmittedClue, true);
			equal(view.players.find(p => p.name === givers[0].name)?.clue, null);
			game.submitClue(givers[1], "river");
			equal(givers[0].clueValid, !enabled);
			game._resetToLobby();
		}
		game.start(); game.clearTimer(); game._secretWord = "apple"; game._advanceClueInput();
		game._players.filter(p => !p.isGuesser).forEach(p => game.submitClue(p, "zzquux"));
		assert(game._players.filter(p => !p.isGuesser).every(p => p.clueValid === false), "Exact duplicates still invalid");
	} finally { game.close("destroy"); }
});

Deno.test("six consecutive games return to lobby and reset state, keep settings", () => {
	const { game, players } = room();
	try {
		game.setPlayerColor(players[1], "#BE123C");
		game.setDictionaryValidation(game.owner, false);
		for (let i = 0; i < 6; i++) {
			game.start();
			while (game.phase !== Phase.GAME_END) {
				setupRound(game);
				game.submitGuess(game._currentGuesser!, i % 2 ? "wrong" : "apple");
				game.advanceAfterRound(game.owner);
			}
			equal(game._roundResults.length, players.length);
			equal(new Set(game._roundResults.map(r => r.guesserName)).size, players.length);
			for (const p of players.slice(0, -1)) { game.returnToLobby(p); equal(game.phase, Phase.GAME_END); }
			game.returnToLobby(players.at(-1)!);
			equal(game.phase, Phase.LOBBY);
			equal(game._teamScore, 0); equal(game._roundResults, []);
			assert(players.every(p => p.clue === null && !p.isGuesser && !p.readyForLobby), "All transient state cleared");
			equal(players[1].color, "#BE123C"); equal(game.dictionaryValidation, false);
		}
	} finally { game.close("destroy"); }
});

Deno.test("active old room survives collection; stale room closes without corrupting registry", () => {
	const a = room(), b = room(), c = room();
	try {
		a.game.ts = -31 * 60 * 1000;
		a.game.setDictionaryValidation(a.game.owner, false);
		b.game.ts = -31 * 60 * 1000;
		collectGarbage();
		equal(Game.find(a.game.name), a.game);
		equal(Game.find(b.game.name), undefined);
		equal(Game.find(c.game.name), c.game);
	} finally { [a, b, c].forEach(r => r.game.close("destroy")); }
});

Deno.test("last unready player disconnecting unblocks return; similarity rule unchanged", () => {
	const { game, players } = room();
	try {
		game.phase = Phase.GAME_END;
		game.returnToLobby(players[0]); game.returnToLobby(players[1]);
		game.removePlayer(players[2]);
		equal(game.phase, Phase.LOBBY);
		equal(game.levenshtein("progress", "progression"), 3);
	} finally { game.close("destroy"); }
});
