// Audit-write seam. The audit module binds the default implementation; other
// modules call this port to record entries (e.g. a compliance overlay).
//
// NOTE on sealed tokens: `createSealedToken` would be the ideal regulatory
// signal here (AML/SAR audit writes are a regulator-mandated invariant under
// MGA/UKGC). However, the plugin host's `ctx.provide(token, factory)` signature
// accepts only `Token<T>`, not `SealedToken<T>` - both at the type level (the
// structural brand `__sealed` makes the types incompatible) and at runtime (the
// host throws if a token description starts with `sealed:`). Consequently, a
// module cannot bind a sealed token to its own implementation without bypassing
// the host API entirely.
//
// Decision: use a regular Token. The invariant is documented here and enforced
// by the module's design (no update/delete routes or service methods). A future
// platform version could add a first-class `bindSealedToken` hook on
// ModuleRegistry that bypasses the overlay-rejection guard for the owning module
// only. Until then this is the safe, pragmatic path. See audit/AGENTS.md.
import { createToken, type Token } from './token.js';

export type AuditWritePort = {
  record(entry: {
    tenantId: string;
    actorId?: string | null;
    actorType: 'player' | 'admin' | 'system';
    action: string;
    resourceType: string;
    resourceId?: string | null;
    before?: unknown;
    after?: unknown;
    ip?: string | null;
    userAgent?: string | null;
    correlationId?: string | null;
  }): Promise<void>;
};

export const AUDIT_WRITER: Token<AuditWritePort> = createToken<AuditWritePort>('AUDIT_WRITER');
