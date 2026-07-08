# Lobby

Read-only aggregation over `gaming` games: categories (`lobby.listCategories`, `lobby.getCategoryBySlug`), featured slots (`lobby.getFeatured`), and search (`lobby.search`).

Caching: `listCategories` and `getFeatured` cache through the `CACHE` port (30s TTL, TTL-only - no invalidation wiring). These feeds tolerate up to 30s staleness after an admin edits categories/featured slots.
