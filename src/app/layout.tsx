import type { Metadata } from "next";

import { SiteHeader } from "./site-header";

import "./globals.css";

export const metadata: Metadata = {
  title: "Personal knowledge base",
  description: "Ask questions of your own notes. Every answer cites its source.",
};

// The header reads the session, so nothing under this layout can be
// statically rendered. Saying so here is clearer than letting a cookie read
// opt each page out by accident.
export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-slate-900 antialiased">
        <SiteHeader />
        {children}
      </body>
    </html>
  );
}
