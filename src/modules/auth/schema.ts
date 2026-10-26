import { z } from "zod";

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/identity/constants";

export const loginSchema = z.object({
  email: z.email({ error: "Informe um e-mail válido." }),
  password: z.string().min(1, { error: "Informe sua senha." }),
});

export const requestResetSchema = z.object({
  email: z.email({ error: "Informe um e-mail válido." }),
});

export const updatePasswordSchema = z
  .object({
    password: z
      .string()
      .min(PASSWORD_MIN_LENGTH, { error: `A senha deve ter ao menos ${PASSWORD_MIN_LENGTH} caracteres.` })
      .max(PASSWORD_MAX_LENGTH, { error: `A senha deve ter no máximo ${PASSWORD_MAX_LENGTH} caracteres.` }),
    confirm: z.string(),
  })
  .refine((data) => data.password === data.confirm, {
    error: "As senhas não coincidem.",
    path: ["confirm"],
  });

export type LoginInput = z.infer<typeof loginSchema>;
