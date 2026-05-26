'use client';

import { useQuery } from '@tanstack/react-query';
import { LobbyCategorySchema, FeaturedSlotSchema } from '@oss/orpc-contract';
import type { z } from 'zod';
import { useOrpcClient } from '../../hooks/use-orpc-client.js';
import { useUI } from '../../ui-provider.js';

type Category = z.infer<typeof LobbyCategorySchema>;
type Featured = z.infer<typeof FeaturedSlotSchema>;

// Player lobby home. Reads the public `lobby.*` surface - no auth required.
export function PlayerLobbyPage() {
  const client = useOrpcClient();
  const { Card, Badge } = useUI();

  const categories = useQuery({
    queryKey: ['lobby', 'categories'],
    queryFn: () => client.lobby.listCategories(),
  });
  const featured = useQuery({
    queryKey: ['lobby', 'featured'],
    queryFn: () => client.lobby.getFeatured(),
  });

  const cats: Category[] = categories.data ?? [];
  const slots: Featured[] = featured.data ?? [];

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-header__title">Lobby</h1>
          <div className="page-header__hint">
            The player home - featured games and categories from the public <code>lobby.*</code>{' '}
            endpoints.
          </div>
        </div>
      </div>

      <section className="player-section">
        <h2 className="player-section__title">Featured</h2>
        {slots.length === 0 ? (
          <p className="muted">No featured games yet. Run a seed script or configure them in CMS.</p>
        ) : (
          <div className="player-grid">
            {slots.map((slot) => (
              <Card key={slot.id} className="player-card">
                {slot.thumbnailUrl ? (
                  <img className="player-card__thumb" src={slot.thumbnailUrl} alt={slot.gameName} />
                ) : (
                  <div className="player-card__thumb player-card__thumb--empty" />
                )}
                <div className="player-card__body">
                  <div className="player-card__title">{slot.gameName}</div>
                  <Badge variant="outline">{slot.placement}</Badge>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="player-section">
        <h2 className="player-section__title">Categories</h2>
        {cats.length === 0 ? (
          <p className="muted">No categories yet.</p>
        ) : (
          <div className="player-grid">
            {cats.map((cat) => (
              <Card key={cat.id} className="player-card">
                <div className="player-card__body">
                  <div className="player-card__title">{cat.name}</div>
                  <Badge>{cat.gameCount} games</Badge>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
