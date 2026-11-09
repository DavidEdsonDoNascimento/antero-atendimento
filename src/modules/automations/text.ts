// Lógica pura (sem I/O) — comparação de respostas do cliente.

/** Minúsculas, sem acento, sem pontuação e com espaços simples: "Olá, Atendente!" → "ola atendente". */
export function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** A resposta é exatamente uma das palavras-chave. */
export function matchesExactly(input: string, keywords: readonly string[]): boolean {
  const normalized = normalizeText(input);
  return normalized !== "" && keywords.some((keyword) => normalizeText(keyword) === normalized);
}

/** A resposta contém uma das palavras-chave como palavras inteiras ("quero falar com atendente"). */
export function containsKeyword(input: string, keywords: readonly string[]): boolean {
  const normalized = ` ${normalizeText(input)} `;
  return keywords.some((keyword) => {
    const word = normalizeText(keyword);
    return word !== "" && normalized.includes(` ${word} `);
  });
}
