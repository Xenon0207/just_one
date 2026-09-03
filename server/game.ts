import Player from "./player.ts";
import { Phase, GameState, CluePair, RoundResult } from "../src/rules.ts";
import { stemmer } from "npm:stemmer@2.0.1";

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

// One stable palette for every lobby. The most distinct colours come first,
// followed by progressively closer alternatives. Colours recycle after 20.
const PLAYER_PALETTE: readonly string[] = [
	"#7C3AED", "#0369A1", "#047857", "#B45309", "#BE123C",
	"#3730A3", "#0F766E", "#C2410C", "#9D174D", "#334155",
	"#5B21B6", "#1D4ED8", "#075985", "#0E7490", "#166534",
	"#3F6212", "#854D0E", "#9A3412", "#991B1B", "#701A75"
];

export default class Game {
	_players: Player[] = [];
	ts = performance.now();
	
	// Just One State
	phase: Phase = Phase.LOBBY;
	_round = 0;
	_secretWord: string | null = null;
	_guesserIndex = -1;
	_guesserOrder: Player[] = [];
	_currentGuesser: Player | null = null;
	paused = false;
	dictionaryValidation = true;
	_timerMs = 0;
	_timerInterval: ReturnType<typeof setInterval> | null = null;
	_similarPairs: CluePair[] = [];
	_teamScore = 0;
	_roundResults: RoundResult[] = [];

	static find(name: string) {
		return games.filter(g => g.name == name)[0];
	}

	constructor(readonly name: string, public owner: Player) {
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
		this._assignDefaultColors();
		this.ts = performance.now();
		player.game = this;

		this._notifyGameChange();
	}

	removePlayer(player: Player) {
		let index = this._players.indexOf(player);
		if (index == -1) { return; }

		this._players.splice(index, 1);
		if (this.phase === Phase.LOBBY) this._assignDefaultColors();
		this.ts = performance.now();
		player.game = null;

		if (player == this.owner && this.phase == Phase.LOBBY) { return this.close("destroy"); }
		if (player == this.owner && this._players.length) this.owner = this._players[0];

		if (this._players.length) {
			if (player === this._currentGuesser && ![Phase.ROUND_END, Phase.GAME_END, Phase.LOBBY].includes(this.phase)) {
				// Keep the result boundary manual even if the guesser disconnects.
				this.clearTimer();
				this.phase = Phase.ROUND_END;
			}
			if (this.phase === Phase.GAME_END && this._players.every(p => p.readyForLobby)) {
				this._resetToLobby();
			} else {
				this._notifyGameChange();
			}
		} else {
			this.close("destroy");
		}
	}

	start() {
		this._assertRunning();
		if (this.phase != Phase.LOBBY) { throw new Error("Too late to start this game"); }
		this._guesserIndex = -1;
		this._teamScore = 0;
		this._round = 0;
		this._roundResults = [];
		this.paused = false;
		this._guesserOrder = [...this._players];
		for (let i = this._guesserOrder.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[this._guesserOrder[i], this._guesserOrder[j]] = [this._guesserOrder[j], this._guesserOrder[i]];
		}
		this._advanceSetupRound();
	}

	setDictionaryValidation(player: Player, enabled: boolean) {
		if (player !== this.owner || this.phase !== Phase.LOBBY) throw new Error("Only the host can change lobby settings");
		if (typeof enabled !== "boolean") throw new Error("Invalid dictionary setting");
		this.dictionaryValidation = enabled;
		this._notifyGameChange();
	}

	setPaused(player: Player, paused: boolean) {
		if (player !== this.owner) throw new Error("Only the host can pause or resume");
		if (typeof paused !== "boolean") throw new Error("Invalid pause setting");
		this.paused = paused;
		this._notifyGameChange();
	}

	_assertRunning() {
		if (this.paused) throw new Error("The host has paused the game");
	}

	getAvailableColors() {
		return [...PLAYER_PALETTE];
	}

	setPlayerColor(player: Player, color: string) {
		if (this.phase !== Phase.LOBBY) { throw new Error("Colors can only be changed in the lobby"); }
		const normalized = color.toUpperCase();
		if (!this.getAvailableColors().includes(normalized)) { throw new Error("Color is not available"); }
		player.color = normalized;
		player.colorCustomized = true;
		this._notifyGameChange();
	}

	_assignDefaultColors() {
		this._players.forEach((player, index) => {
			if (!player.colorCustomized) player.color = PLAYER_PALETTE[index % PLAYER_PALETTE.length];
		});
	}

	_advanceSetupRound() {
		this.clearTimer();
		this._round++;
		this._guesserIndex++;
		while (this._guesserIndex < this._guesserOrder.length && !this._players.includes(this._guesserOrder[this._guesserIndex])) {
			this._guesserIndex++;
		}

		if (this._guesserIndex >= this._guesserOrder.length) {
			this.phase = Phase.GAME_END;
			this._currentGuesser = null;
			this._players.forEach(p => p.isGuesser = false);
			this._notifyGameChange();
			return;
		}

		this._currentGuesser = this._guesserOrder[this._guesserIndex];
		this._players.forEach(p => {
			p.isGuesser = p === this._currentGuesser;
			p.clue = null;
			p.clueValid = null;
			p.votedDuplicatePairs = {};
			p.readyForLobby = false;
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
		this._assertRunning();
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
		this._assertRunning();
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
			if (this.dictionaryValidation && !existsInDict) return;

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

		// 3. Nearby spellings and shared stems are voting candidates, not automatic discards.
		const validPlayers = this._players.filter(p => !p.isGuesser && p.clueValid);
		const normalizedClues = validPlayers.map(p => p.clue!.toLowerCase().replace(/-/g, ""));
		const clueStems = normalizedClues.map(clue => stemmer(clue));
		this._similarPairs = [];

		for (let i = 0; i < validPlayers.length; i++) {
			for (let j = i + 1; j < validPlayers.length; j++) {
				const p1 = validPlayers[i];
				const p2 = validPlayers[j];
				const dist = this.levenshtein(normalizedClues[i], normalizedClues[j]);
				const sameStem = clueStems[i].length > 0 && clueStems[i] === clueStems[j];
				if (dist <= 2 || sameStem) {
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
		this._assertRunning();
		if (this.phase !== Phase.VOTE_SIMILARITY || player.isGuesser) return;
		const pair = this._similarPairs.find(p => p.id === pairId);
		if (!pair) return;

		const previousVote = player.votedDuplicatePairs[pairId];
		if (previousVote === keep) return;
		if (previousVote === true) pair.votesKeep--;
		if (previousVote === false) pair.votesDiscard--;

		player.votedDuplicatePairs[pairId] = keep;
		if (keep) pair.votesKeep++;
		else pair.votesDiscard++;

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
		this._assertRunning();
		if (this.phase !== Phase.GUESS || !player.isGuesser) return;
		
		const correct = guess.trim().toLowerCase() === this._secretWord?.toLowerCase();
		if (correct) {
			this._teamScore++;
		}

		this._roundResults.push({
			round: this._round,
			guesserName: player.name,
			guesserColor: player.color,
			correct,
			word: this._secretWord || "",
			guess: guess.trim(),
			validClues: this._players
				.filter(clueGiver => !clueGiver.isGuesser && clueGiver.clueValid)
				.map(clueGiver => ({
					playerName: clueGiver.name,
					playerColor: clueGiver.color,
					clue: clueGiver.clue || "(no clue)"
				})),
			invalidClues: this._players
				.filter(clueGiver => !clueGiver.isGuesser && !clueGiver.clueValid)
				.map(clueGiver => ({
					playerName: clueGiver.name,
					playerColor: clueGiver.color,
					clue: clueGiver.clue || "(no clue)"
				}))
		});

		this.phase = Phase.ROUND_END;
		this._notifyGameChange();
	}

	advanceAfterRound(player: Player) {
		if (player !== this.owner) throw new Error("Only the host can continue");
		this._assertRunning();
		if (this.phase !== Phase.ROUND_END) return;
		this._advanceSetupRound();
	}

	returnToLobby(player: Player) {
		this._assertRunning();
		if (this.phase !== Phase.GAME_END) return;
		player.readyForLobby = true;
		if (this._players.every(p => p.readyForLobby)) {
			this._resetToLobby();
		} else {
			this._notifyGameChange();
		}
	}

	_resetToLobby() {
		this.clearTimer();
		this.phase = Phase.LOBBY;
		this._round = 0;
		this._guesserIndex = -1;
		this._currentGuesser = null;
		this._guesserOrder = [];
		this.paused = false;
		this._secretWord = null;
		this._similarPairs = [];
		this._teamScore = 0;
		this._roundResults = [];
		this._players.forEach(player => {
			player.isGuesser = false;
			player.hasVotedSkip = false;
			player.clue = null;
			player.clueValid = null;
			player.votedDuplicatePairs = {};
			player.readyForLobby = false;
		});
		this._notifyGameChange();
	}

	getInfo(player: Player): GameState {
		return {
			phase: this.phase,
			paused: this.paused,
			dictionaryValidation: this.dictionaryValidation,
			isOwner: player === this.owner,
			players: this._players.map(p => {
				const state = p.toJSON();
				// Submission progress never needs to reveal the submitted word.
				if (p !== player && (this.phase === Phase.CLUE_INPUT || (player.isGuesser && this.phase === Phase.VOTE_SIMILARITY))) state.clue = null;
				return state;
			}),
			availableColors: this.getAvailableColors(),
			// Hide secret word from guesser unless round is over
			secretWord: (this.phase === Phase.ROUND_END || this.phase === Phase.GAME_END || !player.isGuesser) ? this._secretWord : null,
			guesserName: this._currentGuesser?.name || null,
			timerMs: this._timerMs,
			similarPairs: player.isGuesser ? [] : this._similarPairs,
			teamScore: this._teamScore,
			round: this._round,
			totalRounds: this._round + this._guesserOrder.slice(this._guesserIndex + 1).filter(p => this._players.includes(p)).length,
			roundResults: this._roundResults
		};
	}

	close(reason: "destroy" | "over") {
		this.clearTimer();
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
		this.ts = performance.now();
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
			if (this.paused) return;
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

export function collectGarbage() {
	let now = performance.now();
	for (const game of [...games]) {
		if ((now-game.ts) < GARBAGE_THRESHOLD) continue;
		console.log("Closing idle game", game.name);
		game.close("destroy");
	}
}

const garbageTimer = setInterval(collectGarbage, 5*1000);
Deno.unrefTimer(garbageTimer);
