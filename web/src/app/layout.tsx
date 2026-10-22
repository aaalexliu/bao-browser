import type { ReactNode } from "react";
import { viewer } from "@/lib/viewer";
import "./globals.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Bao",
  description: "Workflows that stay in sync across your machines.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  let name = "";
  try {
    name = (await viewer())?.name || "";
  } catch (err) {
    console.error(err);
  }
  return (
    <html lang="en">
      <body>
        <header>
          <strong>Bao</strong>
          <nav>
            <a href="/">Library</a>
            <a href="/marketplace">Marketplace</a>
            <a href="/pair">Devices</a>
          </nav>
          <div className="who">
            {name ? (
              <form action="/api/auth/logout" method="post">
                <button type="submit">Sign out {name}</button>
              </form>
            ) : (
              <a href="/login">Sign in</a>
            )}
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
