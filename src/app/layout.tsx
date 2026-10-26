import type { Metadata } from "next";
import localFont from "next/font/local";

import "./globals.css";

// Geist e Geist Mono locais (OFL — ver fonts/README.md): o build não depende
// de baixar fontes do Google. Fontes variáveis, mesmos pesos de antes.
const geistSans = localFont({
  src: "./fonts/Geist-latin.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
});

const geistMono = localFont({
  src: "./fonts/GeistMono-latin.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: {
    default: "Antero Atendimento",
    template: "%s · Antero Atendimento",
  },
  description:
    "Plataforma de atendimento inteligente integrada ao WhatsApp — Antero Sistemas.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="pt-BR"
      className={`${geistSans.variable} ${geistMono.variable} antialiased`}
    >
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
