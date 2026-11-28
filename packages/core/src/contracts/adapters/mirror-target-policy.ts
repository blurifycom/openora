import { createToken, type Token } from './token.js';

export type MirrorTargetPolicy = {
  isApprovedTarget(tx: unknown, origin: string): Promise<boolean>;
};

export const MIRROR_TARGET_POLICY: Token<MirrorTargetPolicy> = createToken('MIRROR_TARGET_POLICY');
