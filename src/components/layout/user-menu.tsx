"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { IconChevronDown, IconLogout, IconSettings } from "@/components/ui/icons";
import { logout } from "@/modules/auth/actions";

function initialsOf(fullName: string, email: string): string {
  const source = fullName.trim() || email;
  const parts = source.split(/\s+/).filter(Boolean);
  const letters =
    parts.length >= 2 ? parts[0][0] + parts[1][0] : source.slice(0, 2);
  return letters.toUpperCase();
}

export function UserMenu({
  fullName,
  email,
}: {
  fullName: string;
  email: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-md p-1 pr-2 text-sm hover:bg-surface-2"
      >
        <span className="grid size-8 place-items-center rounded-full border border-gold/30 bg-surface-2 text-xs font-semibold text-gold">
          {initialsOf(fullName, email)}
        </span>
        <span className="hidden max-w-[140px] text-left sm:block">
          <span className="block truncate text-sm font-medium text-foreground">
            {fullName || email}
          </span>
        </span>
        <IconChevronDown className="size-4 text-muted-2" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-60 overflow-hidden rounded-md border border-line bg-surface-2 p-1 shadow-xl shadow-black/40"
        >
          <div className="px-3 py-2">
            <p className="truncate text-sm font-medium text-foreground">
              {fullName || "—"}
            </p>
            <p className="truncate text-xs text-muted-2">{email}</p>
          </div>
          <div className="my-1 h-px bg-line" />
          <Link
            href="/configuracoes"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted hover:bg-surface-3 hover:text-foreground"
          >
            <IconSettings className="size-4" />
            Configurações
          </Link>
          <form action={logout}>
            <button
              type="submit"
              role="menuitem"
              className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm text-red-300 hover:bg-red-500/10 hover:text-red-200"
            >
              <IconLogout className="size-4" />
              Sair
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
