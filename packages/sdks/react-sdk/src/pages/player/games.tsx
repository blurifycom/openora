'use client';

import { useQuery } from '@tanstack/react-query';
import { GameSchema } from '@oss/orpc-contract';
import type { z } from 'zod';
import { useOrpcClient } from '../../hooks/use-orpc-client.js';
import { useUI } from '../../ui-provider.js';

type Game = z.infer<typeof GameSchema>;

// Player-facing games catalogue. Browse grid built on the `gaming.listGames`
// endpoint; "Play" launches a round via the game provider adapter.
export function PlayerGamesPage() {
  const client = useOrpcClient();
  const { Card, Badge, Button } = useUI();

  const { data, isLoading } = useQuery({
    queryKey: ['gaming', 'games'],
    queryFn: () => client.gaming.listGames(),
  });

  const games: Game[] = (data ?? []) as Game[];

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-header__title">Games</h1>
          <div className="page-header__hint">
            Browse the catalogue from <code>gaming.listGames</code>. Active games are playable.
          </div>
        </div>
      </div>

      {isLoading ? (
        <p className="muted">Loading games...</p>
      ) : games.length === 0 ? (
        <p className="muted">No games seeded yet.</p>
      ) : (
        <div className="player-grid">
          {games.map((game) => (
            <Card key={game.id} className="player-card">
              {game.thumbnailUrl ? (
                <img className="player-card__thumb" src={game.thumbnailUrl} alt={game.name} />
              ) : (
                <div className="player-card__thumb player-card__thumb--empty" />
              )}
              <div className="player-card__body">
                <div className="player-card__title">{game.name}</div>
                <Badge variant="outline">{game.provider}</Badge>
                <Button size="sm" disabled={!game.isActive}>
                  {game.isActive ? 'Play' : 'Unavailable'}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
