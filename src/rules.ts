export enum Phase {
	LOBBY = "LOBBY",
	SETUP_ROUND = "SETUP_ROUND",
	DRAW = "DRAW",
	CLUE_INPUT = "CLUE_INPUT",
	CLUE_VALIDATION = "CLUE_VALIDATION",
	VOTE_SIMILARITY = "VOTE_SIMILARITY",
	GUESS = "GUESS",
	ROUND_END = "ROUND_END",
	GAME_END = "GAME_END"
}

export interface PlayerState {
	name: string;
	isGuesser: boolean;
	hasVotedSkip: boolean;
	clue: string | null;
	clueValid: boolean | null; // null if not yet validated
	votedDuplicatePairs: Record<string, boolean>; // pairId -> keep?
}

export interface CluePair {
	id: string;
	clue1: string;
	clue2: string;
	votesKeep: number;
	votesDiscard: number;
}

export interface GameState {
	phase: Phase;
	isOwner: boolean;
	players: PlayerState[];
	secretWord: string | null; // Only sent to guesser at the end, or sent to clue givers always? Clue givers need it!
	guesserName: string | null;
	timerMs: number; // Remaining time
	similarPairs: CluePair[];
	teamScore: number;
	round: number;
	totalRounds: number;
}
