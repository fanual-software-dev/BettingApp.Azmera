# Lobby badges

Edit `config/game-badges.json` to assign or remove badges without changing JavaScript. Restart/redeploy the backend after saving; the frontend reads badges from `/api/config`.

The `games` object maps a catalog game ID to badge names in display order. For example, add `"safari-simba": ["new", "hot"]` to show NEW and 🔥 on Safari Simba, or use `[]` to remove them. Badge assignments are editorial labels and do not imply gameplay is connected.

The `definitions` object controls each badge's text (`label`), accessible description (`title`), and optional six-digit hex `color` and `background`. Define another badge here and assign its name to any game; no renderer changes are needed. Missing definitions are ignored. Keep the file valid JSON.

Original games appear in the normal catalog and search/category filters. Guests can watch their live rounds without an account; placing a bet still requires authentication. Supplier games that are not integrated open their preview/coming-soon screen, not invented supplier gameplay.
