import JsonRpc from "./json-rpc.js";
import { Phase, GameState, PlayerState, RoundClue } from "../rules.js";

// Change this to your actual Deno Deploy project URL once created
const PROD_SERVER = "wss://just-one.xenon0207.deno.net/ws";
const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";

const conf = {
	SERVER: isLocal ? `ws://${location.host}/ws` : PROD_SERVER
};

let rpc: JsonRpc | null = null;
let playerName = "";
let gameName = "";
let lastPhase: Phase | null = null;
let lastRound = -1;
let syncing = false;
let syncAgain = false;

function showError(error: unknown) {
	const el = document.getElementById("connection-status")!;
	el.textContent = (error as Error)?.message || "Something went wrong. Please try again.";
	el.hidden = false;
}

async function action(method: string, params: unknown[] = []) {
	try {
		if (!rpc) throw new Error("Connection lost. Refresh to reconnect.");
		await rpc.call(method, params);
		await sync();
	} catch (error) {
		await sync();
		showError(error);
	}
}

// UI Elements
const sections = {
	setup: document.getElementById("setup")!,
	lobby: document.getElementById("lobby")!,
	draw: document.getElementById("draw")!,
	clueInput: document.getElementById("clue-input")!,
	voteSimilarity: document.getElementById("vote-similarity")!,
	guess: document.getElementById("guess")!,
	roundEnd: document.getElementById("round-end")!,
	gameEnd: document.getElementById("game-end")!
};

const timerEl = document.getElementById("timer")!;
const gameHud = document.getElementById("game-hud")!;
const guesserStatus = document.getElementById("guesser-status")!;
const stepRule = document.getElementById("step-rule")!;

const gameSteps = [
	{ label: "Word", rule: "Clue-givers see the mystery word and may vote to redraw it. The guesser looks away." },
	{ label: "Clues", rule: "Give exactly one word. Do not use the mystery word itself." },
	{ label: "Review", rule: "Review similar clues. You may change your vote until everyone has voted." },
	{ label: "Guess", rule: "The guesser gets one attempt using only the valid clues." },
	{ label: "Result", rule: "Review the answer and clues. The host continues when the group is ready." },
	{ label: "Summary", rule: "Review every round in guesser order, then everyone returns to the lobby together." }
];

function stepIndexForPhase(phase: Phase): number {
	switch (phase) {
		case Phase.DRAW:
		case Phase.SETUP_ROUND: return 0;
		case Phase.CLUE_INPUT: return 1;
		case Phase.CLUE_VALIDATION:
		case Phase.VOTE_SIMILARITY: return 2;
		case Phase.GUESS: return 3;
		case Phase.ROUND_END: return 4;
		case Phase.GAME_END: return 5;
		default: return -1;
	}
}

function renderGameHud(state: GameState, me: PlayerState) {
	const activeIndex = stepIndexForPhase(state.phase);
	gameHud.classList.toggle("hidden", activeIndex < 0);
	if (activeIndex < 0) return;

	guesserStatus.textContent = state.phase === Phase.GAME_END
		? "Every player has been the guesser"
		: me.isGuesser
			? "You are the guesser"
			: `${state.guesserName} is the guesser`;
	stepRule.textContent = gameSteps[activeIndex].rule;
	document.querySelectorAll<HTMLElement>("#step-track [data-step]").forEach(item => {
		const step = Number(item.dataset.step);
		item.classList.toggle("is-active", step === activeIndex);
		item.classList.toggle("is-complete", step < activeIndex);
	});
}

function createColoredClue(clue: RoundClue, invalid = false): HTMLLIElement {
	const li = document.createElement("li");
	li.className = `colored-clue${invalid ? " is-invalid" : ""}`;
	li.style.setProperty("--player-color", clue.playerColor);

	const dot = document.createElement("span");
	dot.className = "clue-color";
	const word = document.createElement("strong");
	word.textContent = clue.clue;
	const player = document.createElement("span");
	player.className = "clue-player";
	player.textContent = clue.playerName;
	li.append(dot, word, player);
	return li;
}

function appendClueGroup(parent: HTMLElement, title: string, clues: RoundClue[], invalid = false) {
	const group = document.createElement("div");
	group.className = "summary-clue-group";
	const heading = document.createElement("h4");
	heading.textContent = `${title} (${clues.length})`;
	const list = document.createElement("ul");
	clues.forEach(clue => list.appendChild(createColoredClue(clue, invalid)));
	if (clues.length === 0) {
		const empty = document.createElement("li");
		empty.className = "empty-clues";
		empty.textContent = "None";
		list.appendChild(empty);
	}
	group.append(heading, list);
	parent.appendChild(group);
}

function renderGameHistory(state: GameState) {
	const history = document.getElementById("game-history")!;
	history.innerHTML = "";
	state.roundResults.forEach(result => {
		const card = document.createElement("article");
		card.className = "round-summary";
		card.style.setProperty("--guesser-color", result.guesserColor);

		const header = document.createElement("div");
		header.className = "round-summary-header";
		const title = document.createElement("h3");
		title.textContent = `${result.round}. ${result.guesserName}`;
		const badge = document.createElement("span");
		badge.className = `result-badge ${result.correct ? "is-correct" : "is-wrong"}`;
		badge.textContent = result.correct ? "Guessed right" : "Not guessed";
		header.append(title, badge);

		const word = document.createElement("p");
		word.className = "summary-word";
		word.append("Word: ");
		const strong = document.createElement("strong");
		strong.textContent = result.word;
		word.appendChild(strong);
		const guessed = document.createElement("small");
		guessed.className = "summary-guess";
		guessed.textContent = `Guess: ${result.guess || "(no guess)"}`;
		word.appendChild(guessed);
		card.append(header, word);
		appendClueGroup(card, "Valid clues", result.validClues);
		appendClueGroup(card, "Invalid clues", result.invalidClues, true);
		history.appendChild(card);
	});
}

function showSection(id: keyof typeof sections) {
	Object.values(sections).forEach(s => s.classList.remove("active"));
	sections[id].classList.add("active");
}

function updateTimer(ms: number) {
	if (ms <= 0) {
		timerEl.classList.add("hidden");
	} else {
		timerEl.classList.remove("hidden");
		timerEl.textContent = Math.ceil(ms / 1000).toString() + "s";
	}
}

async function connectRPC(): Promise<JsonRpc> {
	if (rpc) return rpc;
	const ws = new WebSocket(conf.SERVER);
	return new Promise((resolve, reject) => {
		ws.addEventListener("open", () => {
			let io = {
				onData(_s:string) {},
				sendData(s:string) { ws.send(s); }
			}
			ws.addEventListener("message", e => io.onData(e.data));
			rpc = new JsonRpc(io);
			const connectedRpc = rpc;
			const poll = setInterval(() => void sync(), 15000);
			ws.addEventListener("close", () => {
				clearInterval(poll);
				connectedRpc.disconnect();
				if (rpc === connectedRpc) rpc = null;
				showError(new Error("Connection lost. Refresh to reconnect."));
			});

			rpc.expose("game-change", () => sync());
			rpc.expose("game-destroy", () => {
				alert("The game has been cancelled");
				location.reload();
			});
			rpc.expose("game-over", () => {
				sync();
			});

			resolve(rpc);
		});
		ws.addEventListener("error", () => reject(new Error("Cannot connect to server")));
	});
}

async function joinOrCreate(type: "join" | "create") {
	playerName = (document.getElementById("player-name") as HTMLInputElement).value;
	gameName = (document.getElementById("game-name") as HTMLInputElement).value;

	if (!playerName || !gameName) return alert("Please provide both names.");

	try {
		const clientRpc = await connectRPC();
		await clientRpc.call(type === "create" ? "create-game" : "join-game", [gameName, playerName]);
		
		document.getElementById("lobby-game-name")!.textContent = gameName;
		sync();
	} catch (e) {
		alert((e as Error).message);
	}
}

async function sync() {
	if (!rpc) return;
	if (syncing) { syncAgain = true; return; }
	syncing = true;
	try {
		do {
			syncAgain = false;
			const state: GameState | null = await rpc.call("game-info", []);
			if (!state) {
				if (lastPhase) showError(new Error("This room is no longer available. Refresh to join a room."));
				return;
			}
			document.getElementById("connection-status")!.hidden = true;
			render(state);
		} while (syncAgain && rpc);
	} catch (error) { showError(error); }
	finally { syncing = false; }
}

function render(state: GameState) {
	updateTimer(state.timerMs);
	const enteredRoundEnd = state.phase === Phase.ROUND_END && (lastPhase !== state.phase || lastRound !== state.round);
	if (lastPhase !== state.phase || lastRound !== state.round) {
		(document.getElementById("clue-text") as HTMLInputElement).value = "";
		(document.getElementById("guess-text") as HTMLInputElement).value = "";
		document.getElementById("clue-wait")!.textContent = "";
	}
	lastPhase = state.phase;
	lastRound = state.round;
	document.querySelector(".page-shell")!.classList.toggle("summary-layout", state.phase === Phase.GAME_END);
	document.querySelector(".page-shell")!.classList.toggle("clue-layout", state.phase === Phase.CLUE_INPUT);
	document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("main button, main input").forEach(el => el.disabled = false);
	
	const myPlayer = state.players.find(p => p.name === playerName);
	if (!myPlayer) return;
	renderGameHud(state, myPlayer);
	const pause = document.getElementById("btn-pause") as HTMLButtonElement;
	pause.hidden = !state.isOwner;
	pause.textContent = state.paused ? "Resume Game" : "Pause Game";
	pause.onclick = () => action("set-paused", [!state.paused]);
	document.getElementById("pause-status")!.hidden = !state.paused;

	switch (state.phase) {
		case Phase.LOBBY: {
			showSection("lobby");
			const ul = document.getElementById("lobby-players")!;
			ul.innerHTML = "";
			state.players.forEach(p => {
				const li = document.createElement("li");
				li.className = "player-item";
				li.style.setProperty("--player-color", p.color);
				if (p.name === playerName) li.classList.add("is-you");

				const avatar = document.createElement("span");
				avatar.className = "player-avatar";
				avatar.textContent = p.name.slice(0, 1).toUpperCase();
				avatar.style.backgroundColor = p.color;

				const name = document.createElement("span");
				name.className = "player-label";
				name.textContent = p.name;

				li.append(avatar, name);
				if (p.name === playerName) {
					const badge = document.createElement("span");
					badge.className = "player-badge";
					badge.textContent = "You";
					li.appendChild(badge);
				}
				ul.appendChild(li);
			});

			const colorOptions = document.getElementById("color-options")!;
			colorOptions.innerHTML = "";
			state.availableColors.forEach(color => {
				const swatch = document.createElement("button");
				swatch.className = "color-swatch";
				swatch.style.backgroundColor = color;
				swatch.title = `Choose ${color}`;
				swatch.setAttribute("aria-label", `Choose player colour ${color}`);
				const selected = color.toUpperCase() === myPlayer.color.toUpperCase();
				swatch.classList.toggle("is-selected", selected);
				swatch.setAttribute("aria-pressed", selected.toString());
				swatch.onclick = () => action("set-color", [color]);
				colorOptions.appendChild(swatch);
			});
			const btnStart = document.getElementById("btn-start") as HTMLButtonElement;
			btnStart.hidden = !state.isOwner;
			btnStart.onclick = () => action("start-game");
			const dictionary = document.getElementById("dictionary-validation") as HTMLInputElement;
			dictionary.checked = state.dictionaryValidation;
			dictionary.disabled = !state.isOwner;
			dictionary.onchange = () => action("set-dictionary-validation", [dictionary.checked]);
			const btnLeave = document.getElementById("btn-leave") as HTMLButtonElement;
			btnLeave.onclick = async () => {
				btnLeave.disabled = true;
				try {
					await rpc!.call("quit-game", []);
					location.reload();
				} catch (error) { btnLeave.disabled = false; showError(error); }
			};
			const lobbyStatus = document.getElementById("lobby-status")!;
			lobbyStatus.textContent = state.isOwner
				? "You're the host - start whenever everyone is ready."
				: "Waiting for the host to start the game...";
			break;
		}

		case Phase.SETUP_ROUND:
			// transitional
			break;

		case Phase.DRAW: {
			showSection("draw");
			document.getElementById("draw-role-msg")!.textContent = 
				myPlayer.isGuesser ? `You are the guesser! Wait for them to draw a word.` : `You give clues!`;
			
			const wordEl = document.getElementById("draw-word")!;
			wordEl.textContent = state.secretWord ? state.secretWord : "???";
			
			const skipBtn = document.getElementById("btn-skip") as HTMLButtonElement;
			skipBtn.hidden = myPlayer.isGuesser || myPlayer.hasVotedSkip;
			skipBtn.onclick = () => {
				skipBtn.hidden = true;
				void action("vote-skip");
			};
			break;
		}

		case Phase.CLUE_INPUT: {
			showSection("clueInput");
			document.getElementById("clue-role-msg")!.textContent = 
				myPlayer.isGuesser ? `You are the guesser! Wait for clues.` : `Enter your clue for the word:`;
			
			document.getElementById("clue-word")!.textContent = state.secretWord ? state.secretWord : "???";

			const form = document.getElementById("clue-form")!;
			const wait = document.getElementById("clue-wait")!;
			const roster = document.getElementById("clue-roster")!;
			roster.replaceChildren();
			state.players.forEach(p => {
				const row = document.createElement("li");
				row.className = `submission-player${!p.isGuesser && p.hasSubmittedClue ? " submitted" : ""}`;
				const avatar = document.createElement("span");
				avatar.className = "player-avatar";
				avatar.style.backgroundColor = p.color;
				avatar.textContent = p.name.slice(0, 1).toUpperCase();
				const label = document.createElement("span");
				label.textContent = p.name;
				const status = document.createElement("small");
				status.textContent = p.isGuesser ? "Guesser" : p.hasSubmittedClue ? "Submitted" : "";
				row.append(avatar, label, status);
				roster.appendChild(row);
			});
			
			if (myPlayer.isGuesser) {
				form.classList.add("hidden");
				wait.classList.remove("hidden");
				wait.textContent = "Waiting for the team to submit clues.";
			} else if (myPlayer.clue !== null) {
				form.classList.add("hidden");
				wait.classList.remove("hidden");
				wait.textContent = `You submitted: ${myPlayer.clue}. Waiting for others...`;
			} else {
				form.classList.remove("hidden");
				wait.classList.add("hidden");
				
				const input = document.getElementById("clue-text") as HTMLInputElement;
				const btn = document.getElementById("btn-submit-clue") as HTMLButtonElement;
				btn.onclick = () => {
					void action("submit-clue", [input.value]);
					input.value = "";
				};
			}
			break;
		}

		case Phase.CLUE_VALIDATION:
			// Transitional
			break;

		case Phase.VOTE_SIMILARITY: {
			showSection("voteSimilarity");
			const container = document.getElementById("pairs-container")!;
			container.innerHTML = "";
			
			if (myPlayer.isGuesser) {
				container.textContent = "Wait for others to vote on similar clues.";
				break;
			}

			state.similarPairs.forEach(pair => {
				const div = document.createElement("div");
				div.className = "clue-pair";
				const pairText = document.createElement("p");
				pairText.className = "pair-text";
				pairText.textContent = `"${pair.clue1}" & "${pair.clue2}"`;
				div.appendChild(pairText);

				const selectedVote = myPlayer.votedDuplicatePairs[pair.id];
				const btnRow = document.createElement("div");
				btnRow.className = "btn-row";

				const btnKeep = document.createElement("button");
				btnKeep.className = `success vote-option${selectedVote === true ? " is-selected" : ""}`;
				btnKeep.textContent = "Keep";
				btnKeep.setAttribute("aria-pressed", (selectedVote === true).toString());
				btnKeep.onclick = () => action("vote-duplicate", [pair.id, true]);

				const btnDiscard = document.createElement("button");
				btnDiscard.className = `danger vote-option${selectedVote === false ? " is-selected" : ""}`;
				btnDiscard.textContent = "Discard";
				btnDiscard.setAttribute("aria-pressed", (selectedVote === false).toString());
				btnDiscard.onclick = () => action("vote-duplicate", [pair.id, false]);

				btnRow.append(btnKeep, btnDiscard);
				div.appendChild(btnRow);
				if (selectedVote !== undefined) {
					const status = document.createElement("p");
					status.className = "voted-text";
					status.textContent = `Selected: ${selectedVote ? "Keep" : "Discard"}. You can change this until everyone votes.`;
					div.appendChild(status);
				}
				container.appendChild(div);
			});
			break;
		}

		case Phase.GUESS: {
			showSection("guess");
			document.getElementById("guess-role-msg")!.textContent = 
				myPlayer.isGuesser ? `It's your turn! Guess the word based on these clues:` : `${state.guesserName} is guessing...`;

			const list = document.getElementById("guess-clues")!;
			list.innerHTML = "";
			state.players.forEach(p => {
				if (!p.isGuesser && p.clueValid && p.clue) {
					list.appendChild(createColoredClue({
						playerName: p.name,
						playerColor: p.color,
						clue: p.clue
					}));
				}
			});

			const form = document.getElementById("guess-form")!;
			if (myPlayer.isGuesser) {
				form.classList.remove("hidden");
				const input = document.getElementById("guess-text") as HTMLInputElement;
				const btn = document.getElementById("btn-submit-guess") as HTMLButtonElement;
				btn.onclick = () => {
					void action("submit-guess", [input.value]);
					input.value = "";
				};
			} else {
				form.classList.add("hidden");
			}
			break;
		}

		case Phase.ROUND_END: {
			showSection("roundEnd");
			document.getElementById("end-word")!.textContent = state.secretWord || "???";
			document.getElementById("end-score")!.textContent = state.teamScore.toString();
			const result = state.roundResults.find(r => r.round === state.round);
			document.getElementById("end-guess")!.textContent = `Guess: ${result?.guess || "(no guess)"}`;
			const score = document.getElementById("end-score")!;
			score.classList.toggle("score-correct", !!result?.correct);
			if (enteredRoundEnd) {
				score.classList.remove("score-pop");
				if (result?.correct) {
					void score.offsetWidth;
					score.classList.add("score-pop");
				}
			}
			
			const list = document.getElementById("end-clues")!;
			list.innerHTML = "";
			appendClueGroup(list, "Valid clues", result?.validClues || []);
			appendClueGroup(list, "Invalid clues", result?.invalidClues || [], true);

			const btnNext = document.getElementById("btn-next-round") as HTMLButtonElement;
			btnNext.disabled = false;
			btnNext.hidden = !state.isOwner;
			btnNext.textContent = state.round >= state.totalRounds ? "View Final Results" : "Next Guesser";
			btnNext.onclick = async () => {
				btnNext.disabled = true;
				btnNext.textContent = "Continuing...";
				await action("next-round");
				if (lastPhase === Phase.ROUND_END) btnNext.disabled = false;
			};
			break;
		}

		case Phase.GAME_END: {
			showSection("gameEnd");
			document.getElementById("final-score")!.textContent = state.teamScore.toString();
			renderGameHistory(state);
			const readyCount = state.players.filter(player => player.readyForLobby).length;
			const returnStatus = document.getElementById("return-lobby-status")!;
			const waitingNames = state.players.filter(p => !p.readyForLobby).map(p => p.name);
			returnStatus.textContent = `${readyCount} of ${state.players.length} players are ready to return. Waiting for: ${waitingNames.join(", ") || "nobody"}.`;
			const btnReturn = document.getElementById("btn-return-lobby") as HTMLButtonElement;
			btnReturn.disabled = myPlayer.readyForLobby;
			btnReturn.textContent = myPlayer.readyForLobby ? "Waiting for Everyone..." : "Return to Lobby";
			btnReturn.onclick = async () => {
				btnReturn.disabled = true;
				btnReturn.textContent = "Waiting for Everyone...";
				await action("return-to-lobby");
				if (lastPhase === Phase.GAME_END) btnReturn.disabled = false;
			};
			break;
		}
	}
	if (state.paused) {
		document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("main button, main input").forEach(el => el.disabled = true);
	}
}

document.getElementById("btn-create")!.onclick = () => joinOrCreate("create");
document.getElementById("btn-join")!.onclick = () => joinOrCreate("join");
