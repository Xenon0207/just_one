import JsonRpc from "./json-rpc.js";
import { Phase, GameState } from "../rules.js";

// Change this to your actual Deno Deploy project URL once created
const PROD_SERVER = "wss://just-one.xenon0207.deno.net/ws";
const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";

const conf = {
	SERVER: isLocal ? `ws://${location.host}/ws` : PROD_SERVER
};

let rpc: JsonRpc | null = null;
let playerName = "";
let gameName = "";

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
	const state: GameState = await rpc.call("game-info", []);
	if (!state) return;
	render(state);
}

function render(state: GameState) {
	updateTimer(state.timerMs);
	
	const myPlayer = state.players.find(p => p.name === playerName);
	if (!myPlayer) return;

	switch (state.phase) {
		case Phase.LOBBY: {
			showSection("lobby");
			const ul = document.getElementById("lobby-players")!;
			ul.innerHTML = "";
			state.players.forEach(p => {
				const li = document.createElement("li");
				li.className = "player-item";
				if (p.name === playerName) li.classList.add("is-you");

				const avatar = document.createElement("span");
				avatar.className = "player-avatar";
				avatar.textContent = p.name.slice(0, 1).toUpperCase();

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
			const btnStart = document.getElementById("btn-start") as HTMLButtonElement;
			btnStart.hidden = !state.isOwner;
			btnStart.onclick = () => rpc!.call("start-game", []);
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
				rpc!.call("vote-skip", []);
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
			
			if (myPlayer.isGuesser) {
				form.classList.add("hidden");
				wait.classList.remove("hidden");
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
					rpc!.call("submit-clue", [input.value]);
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
				div.innerHTML = `<p class="pair-text">"${pair.clue1}" & "${pair.clue2}"</p>`;
				
				if (myPlayer.votedDuplicatePairs[pair.id] !== undefined) {
					div.innerHTML += `<p class="voted-text">✓ Vote recorded.</p>`;
				} else {
					const btnRow = document.createElement("div");
					btnRow.className = "btn-row";

					const btnKeep = document.createElement("button");
					btnKeep.className = "success";
					btnKeep.textContent = "Keep";
					btnKeep.onclick = () => rpc!.call("vote-duplicate", [pair.id, true]);
					
					const btnDiscard = document.createElement("button");
					btnDiscard.className = "danger";
					btnDiscard.textContent = "Discard";
					btnDiscard.onclick = () => rpc!.call("vote-duplicate", [pair.id, false]);
					
					btnRow.appendChild(btnKeep);
					btnRow.appendChild(btnDiscard);
					div.appendChild(btnRow);
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
					const li = document.createElement("li");
					li.textContent = p.clue;
					list.appendChild(li);
				}
			});

			const form = document.getElementById("guess-form")!;
			if (myPlayer.isGuesser) {
				form.classList.remove("hidden");
				const input = document.getElementById("guess-text") as HTMLInputElement;
				const btn = document.getElementById("btn-submit-guess") as HTMLButtonElement;
				btn.onclick = () => {
					rpc!.call("submit-guess", [input.value]);
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
			
			const list = document.getElementById("end-clues")!;
			list.innerHTML = "";
			state.players.forEach(p => {
				if (!p.isGuesser) {
					const li = document.createElement("li");
					li.textContent = `${p.name}: ${p.clue || '(none)'} [${p.clueValid ? 'Valid' : 'Discarded'}]`;
					list.appendChild(li);
				}
			});
			break;
		}

		case Phase.GAME_END: {
			showSection("gameEnd");
			document.getElementById("final-score")!.textContent = state.teamScore.toString();
			break;
		}
	}
}

document.getElementById("btn-create")!.onclick = () => joinOrCreate("create");
document.getElementById("btn-join")!.onclick = () => joinOrCreate("join");
