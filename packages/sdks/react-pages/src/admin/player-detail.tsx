'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlayerSchema, PlayerStatusSchema, KycStatusSchema } from '@oss/orpc-contract';
import type { z } from 'zod';
import { Link, useOrpcClient, PageContextProvider, useUI } from '@oss/react-hooks';
import { Slot, SLOTS } from '../ui-plugin/index.js';
import { SkeletonDetail } from '@oss/react-blocks/admin';

type Player = z.infer<typeof PlayerSchema>;

/**
 * Page-scoped data exposed to plugin slot contributors via `usePageContext`.
 *
 *   const { player } = usePageContext<PlayerDetailPageContext>();
 *
 * The `player` is the same object passed to slot fills as `subject`; pulling
 * it from page context lets a fill access it without a re-fetch and without
 * having the host page pass it through props.
 */
export type PlayerDetailPageContext = {
  player: Player | null;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
};
const STATUSES = PlayerStatusSchema.options;
const KYC = KycStatusSchema.options;

const money = (n: number): string =>
  n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

export function PlayerDetailPage({
  id,
  playersPath = '/players',
}: {
  id: string;
  playersPath?: string;
}) {
  const client = useOrpcClient();
  const queryClient = useQueryClient();
  const { Card, Button, Badge, Dialog } = useUI();

  const playerQuery = useQuery({
    queryKey: ['player', 'get', id],
    queryFn: () => client.player.get({ playerId: id }),
  });

  const [editOpen, setEditOpen] = useState(false);
  const [draftStatus, setDraftStatus] = useState<Player['status']>('active');
  const [draftKyc, setDraftKyc] = useState<Player['kycStatus']>('pending');
  const [draftLevel, setDraftLevel] = useState(1);

  const openEdit = (): void => {
    if (!playerQuery.data) return;
    setDraftStatus(playerQuery.data.status);
    setDraftKyc(playerQuery.data.kycStatus);
    setDraftLevel(playerQuery.data.level);
    setEditOpen(true);
  };

  const updateMut = useMutation({
    mutationFn: (input: {
      status: Player['status'];
      kycStatus: Player['kycStatus'];
      level: number;
    }) => client.player.update({ playerId: id, ...input }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['player', 'get', id] });
      queryClient.invalidateQueries({ queryKey: ['player', 'list'] });
      setEditOpen(false);
    },
  });

  const player = playerQuery.data;
  const pageContext = useMemo<PlayerDetailPageContext>(
    () => ({
      player: player ?? null,
      isLoading: playerQuery.isLoading,
      isError: playerQuery.isError,
      refetch: () => {
        void playerQuery.refetch();
      },
    }),
    [player, playerQuery.isLoading, playerQuery.isError, playerQuery.refetch],
  );

  if (playerQuery.isLoading) return <SkeletonDetail />;
  if (playerQuery.isError || !player)
    return (
      <div>
        <Link href={playersPath}>← Back to players</Link>
        <div className="muted" style={{ marginTop: '1rem' }}>
          Player not found.
        </div>
      </div>
    );

  return (
    <PageContextProvider<PlayerDetailPageContext> value={pageContext}>
      <div className="page-header">
        <div>
          <Link href={playersPath} className="muted">
            ← Players
          </Link>
          <h1 className="page-header__title">{player.displayName}</h1>
          <div className="page-header__hint">{player.email}</div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <Slot<Player> name={SLOTS.playerDetail.actions} subject={player} />
          <Button onClick={openEdit}>Edit</Button>
        </div>
      </div>

      <Card>
        <div style={{ padding: '1.25rem' }}>
          <div className="detail-grid">
            <div className="detail-grid__label">Player ID</div>
            <div>
              <code>{player.id}</code>
            </div>
            <div className="detail-grid__label">User ID</div>
            <div>
              <code>{player.userId}</code>
            </div>
            <div className="detail-grid__label">Status</div>
            <div>
              <Badge variant={player.status === 'active' ? 'success' : 'warning'}>
                {player.status.replace('_', ' ')}
              </Badge>
            </div>
            <div className="detail-grid__label">KYC</div>
            <div>
              <Badge
                variant={
                  player.kycStatus === 'verified'
                    ? 'success'
                    : player.kycStatus === 'rejected'
                      ? 'destructive'
                      : 'warning'
                }
              >
                {player.kycStatus}
              </Badge>
            </div>
            <div className="detail-grid__label">Level</div>
            <div>
              <Badge variant="outline">L{player.level}</Badge>
            </div>
            <div className="detail-grid__label">Country</div>
            <div>{player.country ?? '-'}</div>
            <div className="detail-grid__label">Currency</div>
            <div>{player.currency}</div>
            <div className="detail-grid__label">Total wagered</div>
            <div>{money(player.totalWagered)}</div>
            <div className="detail-grid__label">Total deposits</div>
            <div>{money(player.totalDeposits)}</div>
            <div className="detail-grid__label">Joined</div>
            <div>{new Date(player.createdAt).toLocaleString()}</div>
          </div>
        </div>
      </Card>

      <Slot<Player> name={SLOTS.playerDetail.sections} subject={player} />

      <Dialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="Edit player"
        description={player.email}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div>
            <div style={{ fontSize: '0.85rem', marginBottom: '0.35rem' }}>Status</div>
            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
              {STATUSES.map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={draftStatus === s ? 'primary' : 'outline'}
                  onClick={() => setDraftStatus(s)}
                  type="button"
                >
                  {s.replace('_', ' ')}
                </Button>
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.85rem', marginBottom: '0.35rem' }}>KYC</div>
            <div style={{ display: 'flex', gap: '0.4rem' }}>
              {KYC.map((k) => (
                <Button
                  key={k}
                  size="sm"
                  variant={draftKyc === k ? 'primary' : 'outline'}
                  onClick={() => setDraftKyc(k)}
                  type="button"
                >
                  {k}
                </Button>
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.85rem', marginBottom: '0.35rem' }}>Level: {draftLevel}</div>
            <input
              type="range"
              min={0}
              max={100}
              value={draftLevel}
              onChange={(e) => setDraftLevel(Number(e.target.value))}
              style={{ width: '100%' }}
            />
          </div>
          {updateMut.error instanceof Error && (
            <div className="auth-screen__error">{updateMut.error.message}</div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
            <Button variant="ghost" onClick={() => setEditOpen(false)} type="button">
              Cancel
            </Button>
            <Button
              loading={updateMut.isPending}
              onClick={() =>
                updateMut.mutate({ status: draftStatus, kycStatus: draftKyc, level: draftLevel })
              }
              type="button"
            >
              Save
            </Button>
          </div>
        </div>
      </Dialog>
    </PageContextProvider>
  );
}
