import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MWG CRM",
  description:
    "Internal CRM platform for Morgan White Group — lead and relationship management with Azure Entra SSO and Outlook integration.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
