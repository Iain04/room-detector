import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "got room? — Room availability",
  description: "Check room occupancy and availability at a glance.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
