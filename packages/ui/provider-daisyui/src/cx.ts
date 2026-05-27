// Join class names, dropping falsy values. Lets each component layer its DaisyUI
// classes on top of any className the caller passes.
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
