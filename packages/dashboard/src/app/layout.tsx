// packages/dashboard/src/app/layout.tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NexusGuard — Blast-Radius Dashboard",
  description: "IBM Bob-powered blast-radius analysis and self-healing for TypeScript monorepos",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
