# Just One - Game Design & Architecture

## 1. Overview
This project is a web-based, multiplayer version of the cooperative board game "Just One". It features a real-time multiplayer architecture with a authoritative backend and a lightweight frontend client. 

## 2. Technical Stack
- **Backend (Server)**: Deno HTTP server with WebSocket upgrades. Deployed to Deno Deploy.
- **Frontend (Client)**: Vanilla TypeScript, HTML, and CSS. Hosted on GitHub Pages.
- **Communication Protocol**: Custom JSON-RPC over WebSockets. The client sends gameplay actions (e.g., `submitClue`, `voteSkip`), and the server broadcasts authoritative state updates (e.g., `gameStateUpdate`).

## 3. Game Rules & Flow
Just One is a cooperative party game where players work together to discover as many mystery words as possible. 

1. One player is randomly chosen as the "Guesser" for the round.
2. The server selects a mystery word.
3. All other players ("Clue-givers") privately write a single-word clue.
4. Invalid or identical clues are automatically discarded.
5. The Guesser sees the remaining clues and gets one chance to guess the mystery word.
6. A correct guess scores 1 point for the team.

## 4. State Machine Architecture
The server manages the game loop via a strict state machine, broadcasting changes to all connected clients.

### 1. `LOBBY`
- Players connect to a specific room using a custom Game Name.
- Players can see who is currently in the lobby.
- Any player can start the game once everyone is ready.

### 2. `SETUP_ROUND`
- The system automatically rotates the Guesser role.
- A mystery word is randomly selected from the dictionary.

### 3. `DRAW` (5 seconds)
- The Guesser is instructed to wait.
- Clue-givers see the mystery word. They have 5 seconds to vote to skip the word if they feel it is too difficult.
- If any Clue-giver votes to skip, a new word is drawn immediately (`SETUP_ROUND`).

### 4. `CLUE_INPUT` (60 seconds)
- Clue-givers must input a valid single-word clue (letters and hyphens only).
- The client-side UI prevents submission of spaces or invalid characters.
- Players missing the timeout forfeit their chance to give a clue for this round.

### 5. `CLUE_VALIDATION` (Automated)
- The server gathers all submitted clues and applies strict auto-discard rules:
  - **Rule 1**: The clue contains spaces (multiple words).
  - **Rule 2**: The clue contains or is contained by the mystery word (case-insensitive).
  - **Rule 3**: Exact duplicates (case-insensitive, ignoring hyphens). If multiple players submit the identical clue, all instances are discarded.

### 6. `VOTE_SIMILARITY` (15 seconds)
- To handle edge cases like pluralization or minor misspellings, the server calculates the Levenshtein distance between all remaining valid clues.
- If the distance between two clues is $\le 2$, or if a clue is not found in the dictionary, a voting phase is triggered.
- Clue-givers vote to "Keep" or "Discard" the flagged clues.
- If >50% of the votes are "Discard", the flagged clues are removed.

### 7. `GUESS`
- The remaining, validated clues are revealed to the Guesser.
- The Guesser attempts to guess the mystery word based on the clues.

### 8. `ROUND_END`
- The server checks if the Guesser's input exactly matches the mystery word (case-insensitive).
- The team score is updated (+1 point for a correct guess).
- The results, including discarded clues, are displayed to all players.
- The game automatically proceeds to `SETUP_ROUND` unless everyone has been the Guesser once.

### 9. `GAME_END`
- Once all players have taken their turn as the Guesser, the final team score is presented.

## 5. Acknowledgments & Credits
This project was built upon the robust multiplayer networking architecture and WebSocket + JSON-RPC implementation from the [rri-master](https://github.com/ondras/rri) repository by Ondřej Žára. The underlying engine was adapted to replace the core gameplay loop with the rules of the cooperative party game "Just One".
