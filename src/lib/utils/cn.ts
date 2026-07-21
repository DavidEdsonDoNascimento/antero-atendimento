/**
 * Concatena classes condicionalmente, ignorando valores falsy.
 * Mantido propositalmente simples — sem dependências externas.
 */
export function cn(
  ...classes: Array<string | false | null | undefined>
): string {
  return classes.filter(Boolean).join(" ");
}
