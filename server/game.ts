import Player from "./player.ts";
import { Phase, GameState, CluePair } from "../src/rules.ts";

let games: Game[] = [];
const GARBAGE_THRESHOLD = 30 * 60 * 1000;

async function loadClueDictionary() {
	const data: unknown = JSON.parse(await Deno.readTextFile("./dictionary.json"));
	if (!Array.isArray(data)) { throw new Error("dictionary.json must contain an array of words"); }

	const words = data.filter((word): word is string => typeof word === "string");
	if (!words.length) { throw new Error("dictionary.json must contain at least one word"); }
	return new Set(words.map(word => word.toLowerCase()));
}

async function loadSecretWords() {
	const data = await Deno.readTextFile("./words.txt");
	const words = data
		.split(/\r?\n/)
		.map(word => word.trim())
		.filter(Boolean);
	if (!words.length) { throw new Error("words.txt must contain at least one word"); }
	return words;
}

const CLUE_DICTIONARY = await loadClueDictionary();
const SECRET_WORDS = await loadSecretWords();

export default class Game {
	_players: Player[] = [];
	ts = performance.now();
	
	// Just One State
	phase: Phase = Phase.LOBBY;
	_round = 0;
	_secretWord: string | null = null;
	_guesserIndex = -1;
	_timerMs = 0;
	_timerInterval: ReturnType<typeof setInterval> | null = null;
	_similarPairs: CluePair[] = [];
	_teamScore = 0;

	static find(name: string) {
		return games.filter(g => g.name == name)[0];
	}

	constructor(readonly name: string, readonly owner: Player) {
		if (Game.find(name)) { throw new Error(`The game "${name}" already exists`); }

		this._log("created");
		this.addPlayer(owner);

		games.push(this);
	}

	playerByKey(key: string) {
		return this._players.filter(p => p.key == key)[0];
	}

	addPlayer(player: Player) {
		if (this.phase !== Phase.LOBBY) {
			throw new Error("Game already started");
		}
		this._players.forEach(p => {
			if (p.name == player.name) { throw new Error(`Player "${player.name}" already exists in this game`); }
		});
		this._players.push(player);
		this.ts = performance.now();
		player.game = this;

		this._notifyGameChange();
	}

	removePlayer(player: Player) {
		let index = this._players.indexOf(player);
		if (index == -1) { return; }

		this._players.splice(index, 1);
		this.ts = performance.now();
		player.game = null;

		if (player == this.owner && this.phase == Phase.LOBBY) { return this.close("destroy"); }

		if (this._players.length) {
			this._notifyGameChange();
		} else {
			this.close("destroy");
		}
	}

	start() {
		if (this.phase != Phase.LOBBY) { throw new Error("Too late to start this game"); }
		this._guesserIndex = -1;
		this._teamScore = 0;
		this._round = 0;
		this._advanceSetupRound();
	}

	_advanceSetupRound() {
		this.clearTimer();
		this._round++;
		this._guesserIndex++;

		if (this._guesserIndex >= this._players.length) {
			this.phase = Phase.GAME_END;
			this._notifyGameChange();
			setTimeout(() => this.close("over"), 10000); // Close after 10s
			return;
		}

		this._players.forEach((p, index) => {
			p.isGuesser = (index === this._guesserIndex);
			p.clue = null;
			p.clueValid = null;
			p.votedDuplicatePairs = {};
		});

		this._drawWord();
	}

	_drawWord() {
		this.clearTimer();
		this._players.forEach(p => p.hasVotedSkip = false);

		// Mystery words come exclusively from the curated game-word list.
		this._secretWord = SECRET_WORDS[Math.floor(Math.random() * SECRET_WORDS.length)];
		this.phase = Phase.DRAW;
		this.startTimer(5 * 1000, () => {
			// Timer expired, nobody skipped. Move to clue input
			this._advanceClueInput();
		});

		this._notifyGameChange();
	}

	voteSkip(player: Player) {
		if (this.phase !== Phase.DRAW || player.isGuesser) return;
		player.hasVotedSkip = true;
		this._drawWord(); // Re-draw for the same guesser and round
	}

	_advanceClueInput() {
		this.clearTimer();
		this.phase = Phase.CLUE_INPUT;
		this.startTimer(60 * 1000, () => {
			// Time is up, move to validation
			this._advanceValidation();
		});
		this._notifyGameChange();
	}

	submitClue(player: Player, clue: string) {
		if (this.phase !== Phase.CLUE_INPUT || player.isGuesser) return;
		player.clue = clue.trim();
		this._notifyGameChange();

		// Check if all clue-givers have submitted
		const allSubmitted = this._players.every(p => p.isGuesser || p.clue !== null);
		if (allSubmitted) {
			this._advanceValidation();
		}
	}

	_advanceValidation() {
		this.clearTimer();
		this.phase = Phase.CLUE_VALIDATION;

		const wordLower = this._secretWord?.toLowerCase() || "";
		
		// 1. Basic Validation
		const clueMap: Record<string, Player[]> = {}; // normalized -> players
		
		this._players.forEach(p => {
			if (p.isGuesser) return;
			p.clueValid = false; // default
			
			const c = p.clue;
			if (!c) return; // No clue = invalid

			// Must be letters and hyphens only
			if (!/^[a-zA-Z\-]+$/.test(c)) return;

			// The full dictionary is used only to validate submitted clues.
			const existsInDict = CLUE_DICTIONARY.has(c.toLowerCase());
			if (!existsInDict) return;

			// Substring check
			const cLower = c.toLowerCase();
			if (wordLower.includes(cLower) || cLower.includes(wordLower)) return;

			// Store for duplicate check
			const normalized = cLower.replace(/-/g, ""); // ignore hyphens for dup check
			if (!clueMap[normalized]) clueMap[normalized] = [];
			clueMap[normalized].push(p);

			p.clueValid = true; // tentative true
		});

		// 2. Exact Duplicates Discard
		Object.values(clueMap).forEach(players => {
			if (players.length > 1) {
				players.forEach(p => p.clueValid = false);
			}
		});

		// 3. Similarity check using Levenshtein distance
		const validPlayers = this._players.filter(p => !p.isGuesser && p.clueValid);
		this._similarPairs = [];

		for (let i = 0; i < validPlayers.length; i++) {
			for (let j = i + 1; j < validPlayers.length; j++) {
				const p1 = validPlayers[i];
				const p2 = validPlayers[j];
				const dist = this.levenshtein(p1.clue!.toLowerCase().replace(/-/g, ""), p2.clue!.toLowerCase().replace(/-/g, ""));
				if (dist <= 2) {
					this._similarPairs.push({
						id: `pair-${i}-${j}`,
						clue1: p1.clue!,
						clue2: p2.clue!,
						votesKeep: 0,
						votesDiscard: 0
					});
				}
			}
		}

		if (this._similarPairs.length > 0) {
			this._advanceVoting();
		} else {
			this._advanceGuess();
		}
	}

	_advanceVoting() {
		this.phase = Phase.VOTE_SIMILARITY;
		this.startTimer(15 * 1000, () => {
			this._resolveVoting();
		});
		this._notifyGameChange();
	}

	voteDuplicate(player: Player, pairId: string, keep: boolean) {
		if (this.phase !== Phase.VOTE_SIMILARITY || player.isGuesser) return;
		if (player.votedDuplicatePairs[pairId] !== undefined) return; // already voted
		
		player.votedDuplicatePairs[pairId] = keep;
		
		const pair = this._similarPairs.find(p => p.id === pairId);
		if (pair) {
			if (keep) pair.votesKeep++;
			else pair.votesDiscard++;
		}

		// Check if everyone has voted for all pairs
		const totalVoters = this._players.length - 1; // excluding guesser
		const allDone = this._similarPairs.every(pair => (pair.votesKeep + pair.votesDiscard) === totalVoters);
		if (allDone) {
			this._resolveVoting();
		} else {
			this._notifyGameChange();
		}
	}

	_resolveVoting() {
		this.clearTimer();
		
		// If discard votes > keep votes, discard the pair
		this._similarPairs.forEach(pair => {
			if (pair.votesDiscard > pair.votesKeep) {
				// Find players who submitted these clues and invalidate them
				this._players.forEach(p => {
					if (!p.isGuesser && p.clueValid && (p.clue === pair.clue1 || p.clue === pair.clue2)) {
						p.clueValid = false;
					}
				});
			}
		});

		this._advanceGuess();
	}

	_advanceGuess() {
		this.clearTimer();
		this.phase = Phase.GUESS;
		this._notifyGameChange();
	}

	submitGuess(player: Player, guess: string) {
		if (this.phase !== Phase.GUESS || !player.isGuesser) return;
		
		const correct = guess.trim().toLowerCase() === this._secretWord?.toLowerCase();
		if (correct) {
			this._teamScore++;
		}

		this.phase = Phase.ROUND_END;
		this._notifyGameChange();

		// Go to next round after 5 seconds
		setTimeout(() => {
			this._advanceSetupRound();
		}, 5000);
	}

	getInfo(player: Player): GameState {
		return {
			phase: this.phase,
			isOwner: player === this.owner,
			players: this._players.map(p => p.toJSON()),
			// Hide secret word from guesser unless round is over
			secretWord: (this.phase === Phase.ROUND_END || this.phase === Phase.GAME_END || !player.isGuesser) ? this._secretWord : null,
			guesserName: this._players[this._guesserIndex]?.name || null,
			timerMs: this._timerMs,
			similarPairs: this._similarPairs,
			teamScore: this._teamScore,
			round: this._round,
			totalRounds: this._players.length
		};
	}

	close(reason: "destroy" | "over") {
		this._log("closed, reason:", reason);

		while (this._players.length) {
			let p = this._players.shift() as Player;
			p.game = null;
			p.jsonrpc.notify(`game-${reason}`, []);
		}

		let index = games.indexOf(this);
		if (index > -1) { games.splice(index, 1); }
	}

	_notifyGameChange() {
		this._players.forEach(player => player.jsonrpc.notify("game-change", []));
	}

	_log(msg: string, ...args: unknown[]) {
		return console.log(`[game ${this.name}] ${msg}`, ...args);
	}

	// Helpers
	startTimer(ms: number, onExpire: () => void) {
		this._timerMs = ms;
		const tick = 1000;
		this._timerInterval = setInterval(() => {
			this._timerMs -= tick;
			if (this._timerMs <= 0) {
				clearInterval(this._timerInterval!);
				this._timerInterval = null;
				this._timerMs = 0;
				onExpire();
			} else {
				this._notifyGameChange();
			}
		}, tick);
	}

	clearTimer() {
		if (this._timerInterval) {
			clearInterval(this._timerInterval);
			this._timerInterval = null;
		}
		this._timerMs = 0;
	}

	levenshtein(a: string, b: string): number {
		if (a.length === 0) return b.length;
		if (b.length === 0) return a.length;
		const matrix = [];
		for (let i = 0; i <= b.length; i++) {
			matrix[i] = [i];
		}
		for (let j = 0; j <= a.length; j++) {
			matrix[0][j] = j;
		}
		for (let i = 1; i <= b.length; i++) {
			for (let j = 1; j <= a.length; j++) {
				if (b.charAt(i - 1) == a.charAt(j - 1)) {
					matrix[i][j] = matrix[i - 1][j - 1];
				} else {
					matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1));
				}
			}
		}
		return matrix[b.length][a.length];
	}
}

function collectGarbage() {
	let now = performance.now();
	games = games.filter(game => {
		if ((now-game.ts) < GARBAGE_THRESHOLD) { return true; }
		console.log("Closing idle game", game.name);
		game.close("destroy");
		return false;
	});
}

setInterval(collectGarbage, 5*1000);
