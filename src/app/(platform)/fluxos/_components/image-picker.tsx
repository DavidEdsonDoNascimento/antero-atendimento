"use client";

import { useActionState, useState } from "react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils/cn";
import type { EditorIssue } from "@/modules/automations/editor";
import { uploadFlowImageAction, type UploadImageState } from "@/modules/automations/editor-actions";

import { imageSrc } from "../_lib/image";
import { IssueText, TextField } from "./fields";

export type ImageOption = { id: string; fileName: string };

const MAX_BYTES = 5 * 1024 * 1024;
const INITIAL: UploadImageState = { status: "idle" };

/**
 * Escolhe a imagem de uma etapa: enviar do computador (fica guardada na
 * organização), reaproveitar uma já enviada ou, como alternativa, um link https.
 */
export function ImagePicker({
  mediaId,
  url,
  images,
  issues,
  onPick,
}: {
  mediaId?: string;
  url?: string;
  images: ImageOption[];
  issues: EditorIssue[];
  onPick: (source: { mediaId: string } | { url: string }) => void;
}) {
  const [uploaded, setUploaded] = useState<ImageOption[]>([]);
  const [tooBig, setTooBig] = useState(false);
  const [useLink, setUseLink] = useState(url !== undefined && mediaId === undefined);
  const [state, formAction, pending] = useActionState(async (previous: UploadImageState, formData: FormData) => {
    const result = await uploadFlowImageAction(previous, formData);
    if (result.status === "uploaded") {
      setUploaded((current) => [result.image, ...current.filter((image) => image.id !== result.image.id)]);
      onPick({ mediaId: result.image.id });
    }
    return result;
  }, INITIAL);

  const gallery = [...uploaded, ...images.filter((image) => !uploaded.some((item) => item.id === image.id))];
  const current = mediaId ? gallery.find((image) => image.id === mediaId) : undefined;

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-foreground">Imagem</p>
      {mediaId ? (
        <div className="flex items-center gap-3 rounded-md border border-line bg-surface-2 p-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- imagem privada da organização, servida pela própria rota */}
          <img src={imageSrc(mediaId)} alt="" className="size-20 rounded object-cover" />
          <p className="min-w-0 truncate text-sm text-foreground">{current?.fileName ?? "Imagem escolhida"}</p>
        </div>
      ) : (
        !useLink && <p className="text-xs text-muted-2">Nenhuma imagem escolhida.</p>
      )}

      {!useLink && (
        <>
          <form
            action={formAction}
            onSubmit={(event) => {
              const file = (event.currentTarget.elements.namedItem("file") as HTMLInputElement).files?.[0];
              const big = file !== undefined && file.size > MAX_BYTES;
              setTooBig(big);
              if (big) event.preventDefault();
            }}
            className="flex flex-wrap items-center gap-2"
          >
            <input
              type="file"
              name="file"
              required
              accept="image/jpeg,image/png"
              aria-label="Arquivo de imagem (JPG ou PNG, até 5 MB)"
              className="max-w-full text-xs text-muted file:mr-2 file:rounded-md file:border file:border-line file:bg-surface-3 file:px-3 file:py-1.5 file:text-xs file:text-foreground"
            />
            <button type="submit" disabled={pending} aria-busy={pending} className={buttonVariants({ variant: "secondary", size: "sm" })}>
              {pending ? "Enviando…" : "Enviar imagem"}
            </button>
          </form>
          <p className="text-xs text-muted-2">JPG ou PNG, até 5 MB. A imagem fica guardada só para a sua organização.</p>
          {tooBig && <p role="alert" className="text-xs text-red-300">A imagem precisa ter até 5 MB.</p>}
          {state.status !== "idle" && (
            <p role={state.status === "uploaded" ? "status" : "alert"} className={cn("text-xs", state.status === "uploaded" ? "text-emerald-300" : "text-red-300")}>
              {state.message}
            </p>
          )}
          {gallery.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs text-muted">Ou escolha uma imagem já enviada:</p>
              <div className="flex flex-wrap gap-2">
                {gallery.slice(0, 24).map((image) => (
                  <button
                    key={image.id}
                    type="button"
                    onClick={() => onPick({ mediaId: image.id })}
                    aria-pressed={image.id === mediaId}
                    title={image.fileName}
                    className={cn(
                      "overflow-hidden rounded border-2 transition-colors",
                      image.id === mediaId ? "border-gold" : "border-transparent hover:border-line-strong",
                    )}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- miniatura privada da organização */}
                    <img src={imageSrc(image.id)} alt={image.fileName} className="size-14 object-cover" loading="lazy" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {useLink && (
        <TextField
          label="Link da imagem"
          value={url ?? ""}
          onChange={(value) => onPick({ url: value })}
          placeholder="https://…"
          hint="A imagem precisa estar publicada na internet, num link https que não mude."
          issues={issues.filter((issue) => issue.field === "url")}
        />
      )}
      <IssueText issues={issues.filter((issue) => issue.field !== "url")} />
      <button
        type="button"
        onClick={() => setUseLink(!useLink)}
        className="text-xs text-muted underline-offset-2 hover:text-foreground hover:underline"
      >
        {useLink ? "Enviar uma imagem do computador" : "Usar um link da internet em vez de enviar"}
      </button>
    </div>
  );
}
