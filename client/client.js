(function () {
    'use strict';

    const V = "2.0";
    function debug(msg, ...args) {
        console.debug(`[jsonrpc] ${msg}`, ...args);
    }
    function warn(msg, ...args) {
        console.warn(`[jsonrpc] ${msg}`, ...args);
    }
    function createErrorMessage(id, code, message, data) {
        let error = { code, message };
        if (data) {
            error.data = data;
        }
        return { id, error, jsonrpc: V };
    }
    function createResultMessage(id, result) {
        return { id, result, jsonrpc: V };
    }
    function createCallMessage(method, params, id) {
        let message = { method, params, jsonrpc: V };
        if (id) {
            message.id = id;
        }
        return message;
    }
    class JsonRpc {
        constructor(_io, options = {}) {
            this._io = _io;
            this._interface = new Map();
            this._pendingPromises = new Map();
            this._options = {
                log: false
            };
            Object.assign(this._options, options);
            _io.onData = (m) => this._onData(m);
        }
        expose(name, method) {
            this._interface.set(name, method);
        }
        async call(method, params) {
            let id = Math.random().toString();
            let message = createCallMessage(method, params, id);
            return new Promise((resolve, reject) => {
                this._pendingPromises.set(id, { resolve, reject });
                this._send(message);
            });
        }
        notify(method, params) {
            let message = createCallMessage(method, params);
            this._send(message);
        }
        _send(message) {
            const str = JSON.stringify(message);
            this._options.log && debug("sending", str);
            this._io.sendData(str);
        }
        _onData(str) {
            this._options.log && debug("received", str);
            let message;
            try {
                message = JSON.parse(str);
            }
            catch (e) {
                let reply = createErrorMessage(null, -32700, e.message);
                this._send(reply);
                return;
            }
            let reply;
            if (message instanceof Array) {
                let mapped = message.map(m => this._processMessage(m)).filter(m => m);
                reply = (mapped.length ? mapped : null);
            }
            else {
                reply = this._processMessage(message);
            }
            reply && this._send(reply);
        }
        _processMessage(message) {
            if ("method" in message) { // call
                const method = this._interface.get(message.method);
                if (!method) {
                    return (message.id ? createErrorMessage(message.id, -32601, "method not found") : null);
                }
                try {
                    const result = (message.params instanceof Array ? method(...message.params) : method(message.params));
                    return (message.id ? createResultMessage(message.id, result) : null);
                }
                catch (e) {
                    this._options.log && warn("caught", e);
                    return (message.id ? createErrorMessage(message.id, -32000, e.message) : null);
                }
            }
            else if (message.id) { // result/error
                let promise = this._pendingPromises.get(message.id);
                if (!promise) {
                    throw new Error(`Received a non-matching response id "${message.id}"`);
                }
                this._pendingPromises.delete(message.id);
                ("error" in message ? promise.reject(message.error) : promise.resolve(message.result));
            }
            else {
                throw new Error("Received a non-call non-id JSON-RPC message");
            }
            return null;
        }
    }

    var Phase;
    (function (Phase) {
        Phase["LOBBY"] = "LOBBY";
        Phase["SETUP_ROUND"] = "SETUP_ROUND";
        Phase["DRAW"] = "DRAW";
        Phase["CLUE_INPUT"] = "CLUE_INPUT";
        Phase["CLUE_VALIDATION"] = "CLUE_VALIDATION";
        Phase["VOTE_SIMILARITY"] = "VOTE_SIMILARITY";
        Phase["GUESS"] = "GUESS";
        Phase["ROUND_END"] = "ROUND_END";
        Phase["GAME_END"] = "GAME_END";
    })(Phase || (Phase = {}));

    // Change this to your actual Deno Deploy project URL once created
    const PROD_SERVER = "wss://just-one.xenon0207.deno.net/ws";
    const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
    const conf = {
        SERVER: isLocal ? `ws://${location.host}/ws` : PROD_SERVER
    };
    let rpc = null;
    let playerName = "";
    let gameName = "";
    // UI Elements
    const sections = {
        setup: document.getElementById("setup"),
        lobby: document.getElementById("lobby"),
        draw: document.getElementById("draw"),
        clueInput: document.getElementById("clue-input"),
        voteSimilarity: document.getElementById("vote-similarity"),
        guess: document.getElementById("guess"),
        roundEnd: document.getElementById("round-end"),
        gameEnd: document.getElementById("game-end")
    };
    const timerEl = document.getElementById("timer");
    function showSection(id) {
        Object.values(sections).forEach(s => s.classList.remove("active"));
        sections[id].classList.add("active");
    }
    function updateTimer(ms) {
        if (ms <= 0) {
            timerEl.classList.add("hidden");
        }
        else {
            timerEl.classList.remove("hidden");
            timerEl.textContent = Math.ceil(ms / 1000).toString() + "s";
        }
    }
    async function connectRPC() {
        if (rpc)
            return rpc;
        const ws = new WebSocket(conf.SERVER);
        return new Promise((resolve, reject) => {
            ws.addEventListener("open", () => {
                let io = {
                    onData(_s) { },
                    sendData(s) { ws.send(s); }
                };
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
    async function joinOrCreate(type) {
        playerName = document.getElementById("player-name").value;
        gameName = document.getElementById("game-name").value;
        if (!playerName || !gameName)
            return alert("Please provide both names.");
        try {
            const clientRpc = await connectRPC();
            await clientRpc.call(type === "create" ? "create-game" : "join-game", [gameName, playerName]);
            document.getElementById("lobby-game-name").textContent = gameName;
            sync();
        }
        catch (e) {
            alert(e.message);
        }
    }
    async function sync() {
        if (!rpc)
            return;
        const state = await rpc.call("game-info", []);
        if (!state)
            return;
        render(state);
    }
    function render(state) {
        updateTimer(state.timerMs);
        const myPlayer = state.players.find(p => p.name === playerName);
        if (!myPlayer)
            return;
        switch (state.phase) {
            case Phase.LOBBY: {
                showSection("lobby");
                const ul = document.getElementById("lobby-players");
                ul.innerHTML = "";
                state.players.forEach(p => {
                    const li = document.createElement("li");
                    li.className = "player-item";
                    if (p.name === playerName)
                        li.classList.add("is-you");
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
                const btnStart = document.getElementById("btn-start");
                btnStart.hidden = !state.isOwner;
                btnStart.onclick = () => rpc.call("start-game", []);
                const lobbyStatus = document.getElementById("lobby-status");
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
                document.getElementById("draw-role-msg").textContent =
                    myPlayer.isGuesser ? `You are the guesser! Wait for them to draw a word.` : `You give clues!`;
                const wordEl = document.getElementById("draw-word");
                wordEl.textContent = state.secretWord ? state.secretWord : "???";
                const skipBtn = document.getElementById("btn-skip");
                skipBtn.hidden = myPlayer.isGuesser || myPlayer.hasVotedSkip;
                skipBtn.onclick = () => {
                    skipBtn.hidden = true;
                    rpc.call("vote-skip", []);
                };
                break;
            }
            case Phase.CLUE_INPUT: {
                showSection("clueInput");
                document.getElementById("clue-role-msg").textContent =
                    myPlayer.isGuesser ? `You are the guesser! Wait for clues.` : `Enter your clue for the word:`;
                document.getElementById("clue-word").textContent = state.secretWord ? state.secretWord : "???";
                const form = document.getElementById("clue-form");
                const wait = document.getElementById("clue-wait");
                if (myPlayer.isGuesser) {
                    form.classList.add("hidden");
                    wait.classList.remove("hidden");
                }
                else if (myPlayer.clue !== null) {
                    form.classList.add("hidden");
                    wait.classList.remove("hidden");
                    wait.textContent = `You submitted: ${myPlayer.clue}. Waiting for others...`;
                }
                else {
                    form.classList.remove("hidden");
                    wait.classList.add("hidden");
                    const input = document.getElementById("clue-text");
                    const btn = document.getElementById("btn-submit-clue");
                    btn.onclick = () => {
                        rpc.call("submit-clue", [input.value]);
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
                const container = document.getElementById("pairs-container");
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
                    }
                    else {
                        const btnRow = document.createElement("div");
                        btnRow.className = "btn-row";
                        const btnKeep = document.createElement("button");
                        btnKeep.className = "success";
                        btnKeep.textContent = "Keep";
                        btnKeep.onclick = () => rpc.call("vote-duplicate", [pair.id, true]);
                        const btnDiscard = document.createElement("button");
                        btnDiscard.className = "danger";
                        btnDiscard.textContent = "Discard";
                        btnDiscard.onclick = () => rpc.call("vote-duplicate", [pair.id, false]);
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
                document.getElementById("guess-role-msg").textContent =
                    myPlayer.isGuesser ? `It's your turn! Guess the word based on these clues:` : `${state.guesserName} is guessing...`;
                const list = document.getElementById("guess-clues");
                list.innerHTML = "";
                state.players.forEach(p => {
                    if (!p.isGuesser && p.clueValid && p.clue) {
                        const li = document.createElement("li");
                        li.textContent = p.clue;
                        list.appendChild(li);
                    }
                });
                const form = document.getElementById("guess-form");
                if (myPlayer.isGuesser) {
                    form.classList.remove("hidden");
                    const input = document.getElementById("guess-text");
                    const btn = document.getElementById("btn-submit-guess");
                    btn.onclick = () => {
                        rpc.call("submit-guess", [input.value]);
                        input.value = "";
                    };
                }
                else {
                    form.classList.add("hidden");
                }
                break;
            }
            case Phase.ROUND_END: {
                showSection("roundEnd");
                document.getElementById("end-word").textContent = state.secretWord || "???";
                document.getElementById("end-score").textContent = state.teamScore.toString();
                const list = document.getElementById("end-clues");
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
                document.getElementById("final-score").textContent = state.teamScore.toString();
                break;
            }
        }
    }
    document.getElementById("btn-create").onclick = () => joinOrCreate("create");
    document.getElementById("btn-join").onclick = () => joinOrCreate("join");

}());
