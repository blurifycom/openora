export function isRgBlocked(u: { rgBlocked: boolean; rgBlockedUntil: Date | null }): boolean {
  return u.rgBlocked && (u.rgBlockedUntil === null || u.rgBlockedUntil > new Date());
}
