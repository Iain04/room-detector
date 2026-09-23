import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Roomwise — Room Overview",
  description: "A live, clear view of your room occupancy and sensor activity.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
