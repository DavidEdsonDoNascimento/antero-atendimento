"use client";

import { useState } from "react";

import { Logo } from "@/components/ui/logo";

import { adminNav, mainNav } from "./nav-config";
import { NavLink } from "./nav-link";

export function MobileNav({ isPlatformAdmin }: { isPlatformAdmin: boolean }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Abrir menu de navegação"
        className="grid size-9 place-items-center rounded-md border border-line text-muted hover:bg-surface-2 hover:text-foreground md:hidden"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          aria-hidden
        >
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={close}
            aria-hidden
          />
          <div className="absolute left-0 top-0 flex h-full w-72 flex-col border-r border-line bg-surface p-3">
            <div className="flex items-center justify-between px-2 pb-3">
              <Logo />
              <button
                type="button"
                onClick={close}
                aria-label="Fechar menu"
                className="grid size-8 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-foreground"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  aria-hidden
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <nav className="space-y-1">
              {mainNav.map((item) => (
                <NavLink
                  key={item.href}
                  href={item.href}
                  label={item.label}
                  soon={item.soon}
                  icon={<item.icon className="size-[18px]" />}
                  onNavigate={close}
                />
              ))}
              {isPlatformAdmin && (
                <div className="pt-4">
                  <p className="mb-1 px-3 text-[11px] font-medium uppercase tracking-wide text-muted-2">
                    Plataforma
                  </p>
                  <NavLink
                    href={adminNav.href}
                    label={adminNav.label}
                    icon={<adminNav.icon className="size-[18px]" />}
                    onNavigate={close}
                  />
                </div>
              )}
            </nav>
          </div>
        </div>
      )}
    </>
  );
}
