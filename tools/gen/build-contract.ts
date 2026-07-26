#!/usr/bin/env node
/**
 * Assembles the full runtime contract from all domain slices.
 * Used by gen-openapi.ts and as a reference for consumer composition roots.
 * Each domain owns its own /contracts slice; this file is the only place that
 * stitches them together. See ADR-0021/0025.
 */
import type { ContractRouter } from '@orpc/contract';
import { composeContract } from '@openora/core/contracts';
import { identityContract } from '@openora/core/pam/contracts/identity';
import { complianceContract } from '@openora/core/compliance/contracts';
import { profileContract } from '@openora/core/pam/contracts/profile';
import { cmsContract } from '@openora/core/cms/contracts';
import { notificationsContract } from '@openora/core/engagement/contracts/notifications';
import { chatContract } from '@openora/core/engagement/contracts/chat';
import { walletContract } from '@openora/core/wallet/contract';
import { gamingContract } from '@openora/core/casino/contracts/gaming';
import { lobbyContract } from '@openora/core/casino/contracts/lobby';
import { backofficeContract } from '@openora/core/admin-console/contract';
import { iamContract } from '@openora/core/iam/contract';
import { auditContract } from '@openora/core/audit/contract';
import { playerContract } from '@openora/core/pam/contracts/player';
import { tagContract } from '@openora/core/pam/contracts/tag';
import { playerNoteContract } from '@openora/core/pam/contracts/player-note';

// oxlint-disable-next-line typescript/no-explicit-any -- root contract is an external oRPC generic
type AnyContract = ContractRouter<any>;

// Order mirrors the historical aggregate so the emitted OpenAPI paths stay stable.
const SLICES: Record<string, AnyContract> = {
  identity: identityContract,
  cms: cmsContract,
  compliance: complianceContract,
  notifications: notificationsContract,
  wallet: walletContract,
  gaming: gamingContract,
  chat: chatContract,
  lobby: lobbyContract,
  backoffice: backofficeContract,
  profile: profileContract,
  iam: iamContract,
  audit: auditContract,
  tag: tagContract,
  'player-note': playerNoteContract,
  player: playerContract,
};

/**
 * Compose the full runtime contract from every module slice.
 */
export function buildContract(): AnyContract {
  return composeContract(SLICES);
}
