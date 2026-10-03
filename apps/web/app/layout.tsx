import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Bhasya — reading with AI attached to the text',
  description: 'Select a passage, get a grounded explanation, return to it later.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__BHASYA_API__=${JSON.stringify(process.env.NEXT_PUBLIC_BHASYA_API_URL ?? 'http://localhost:8787')};`,
          }}
        />
        <header className="topbar">
          <a href="/" className="brand">Bhasya</a>
          <span className="tagline">reading with AI attached to the text</span>
        </header>
        <main className="shell">{children}</main>
      </body>
    </html>
  );
}
