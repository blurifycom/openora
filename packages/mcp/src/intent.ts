export type IntentKind = 'feature' | 'adapter' | 'ui-page' | 'route' | 'unsure';

export function classifyIntent(ask: string): IntentKind {
  const a = ` ${ask.toLowerCase()} `;
  const has = (re: RegExp) => re.test(a);
  if (
    has(/\b(payment|psp|stripe|adyen|kyc|onfido|sms|email|notification|vendor|adapter|gateway)\b/)
  ) {
    return 'adapter';
  }
  if (has(/\b(page|screen|dashboard|view|frontend|admin panel|backoffice page|player page)\b/)) {
    return 'ui-page';
  }
  if (has(/\b(endpoint|route|procedure|api method|rpc)\b/)) {
    return 'route';
  }
  if (
    has(/\b(feature|module|tournament|leaderboard|jackpot|loyalty|bonus|cashback|mission|reward)\b/)
  ) {
    return 'feature';
  }
  return 'unsure';
}
