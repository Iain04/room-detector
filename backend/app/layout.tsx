import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Room Detector",
  description: "WiFi CSI motion detector",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
