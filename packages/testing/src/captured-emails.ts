export type CapturedEmail = { to: string; subject: string; html: string; text: string };

const captured: CapturedEmail[] = [];

export function captureEmail(email: CapturedEmail) {
  captured.push(email);
}

export function capturedEmailsFor(to: string): CapturedEmail[] {
  return captured.filter((e) => e.to.toLowerCase() === to.toLowerCase()).reverse();
}

export function clearCapturedEmails() {
  captured.length = 0;
}
