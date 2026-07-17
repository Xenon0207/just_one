# Just One (Web Edition)

**[🎮 Play Now!](https://Xenon0207.github.io/just_one/)**

A web-based multiplayer cooperative word-guessing game inspired by the popular board game "Just One".

Built with a **Deno** WebSocket backend and a **TypeScript/HTML5** frontend.

`words.txt` is the curated mystery-word pool used for each round. `dictionary.json`
is used only to validate submitted clues.

## How to Play

1. **Lobby**: Create a room and invite your friends to join using the same room name.
2. **Setup**: The game randomly selects one player to be the Guesser for the round. The server picks a secret word.
3. **Draw Phase**: The Guesser waits. The other players (Clue-givers) can see the word and have 5 seconds to vote to skip it if it's too hard.
4. **Clue Input**: Clue-givers have 60 seconds to write a single-word clue (letters and hyphens only).
5. **Validation & Voting**:
   - The game automatically discards invalid clues (e.g., matching the secret word, containing spaces, exact duplicates).
   - If clues are too similar (based on Levenshtein distance), a 15-second voting phase begins. Players vote to keep or discard the similar pairs.
6. **Guess Phase**: The Guesser sees the surviving clues and tries to guess the secret word.
7. **Scoring**: The team gets 1 point for a correct guess. The game ends when everyone has been the Guesser once.

---
*Built upon the multiplayer networking structure of [rri](https://github.com/ondras/rri) by Ondřej Žára.*
