import { z } from "zod";

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
      .min(8, { error: "A senha deve ter ao menos 8 caracteres." }),
    confirm: z.string(),
  })
  .refine((data) => data.password === data.confirm, {
    error: "As senhas não coincidem.",
    path: ["confirm"],
  });

export type LoginInput = z.infer<typeof loginSchema>;
