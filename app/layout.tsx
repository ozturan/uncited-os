import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";

// Validate environment on startup
import "@/lib/env";

export const metadata: Metadata = {
  title: "uncited-os",
  description: "A local, self-hosted uncited. Follow journals and build your research feed on your own machine.",
  icons: {
    // Browser-tab favicon: only the rounded-corner assets. The square
    // icon-192/512 PNGs are PWA/home-screen icons (manifest.json) and must NOT
    // be listed here, or the browser picks the largest (square) one for the tab.
    icon: [
      { url: "/favicon.ico", sizes: "32x32", type: "image/x-icon" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    // iOS home-screen / web-app icon must be a PNG (iOS ignores SVG here).
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    shortcut: "/favicon.ico",
  },
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "uncited-os",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f6f6f7",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="theme-color" content="#f6f6f7" id="theme-color-meta" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;1,400;1,500&display=swap" rel="stylesheet" />
        {/* Radley: serif used for the "uncited" wordmark logo */}
        <link href="https://fonts.googleapis.com/css2?family=Radley:ital@0;1&display=swap" rel="stylesheet" />
      </head>
      <body className="antialiased">
        {/* Apply theme immediately before React hydration to prevent flash */}
        {/* Default to light theme - page-client will apply user's theme preference if logged in */}
        <Script
          id="theme-init"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var theme = 'light';
                  // First check dedicated theme key (new approach)
                  var themeStored = localStorage.getItem('uncited_theme');
                  if (themeStored) {
                    theme = themeStored;
                  } else {
                    // Fallback to old location for backward compatibility
                    var stored = localStorage.getItem('uncited_state');
                    if (stored) {
                      try {
                        theme = JSON.parse(stored).settings?.theme || 'light';
                      } catch (e) {}
                    }
                  }
                  document.documentElement.setAttribute('data-theme', theme);
                } catch (e) {
                  document.documentElement.setAttribute('data-theme', 'light');
                }

                // Update theme-color meta tag based on theme
                function updateThemeColor() {
                  const theme = document.documentElement.getAttribute('data-theme') || 'light';
                  const themeColors = {
                    'light': '#f6f6f7',
                    'dark': '#0a0a0a',
                    'sepia': '#f4f1e8',
                    'retro': '#e8e8e8',
                    'blue': '#0d1f2d',
                    'coral': '#1a1a1a'
                  };
                  const metaThemeColor = document.querySelector('meta[name="theme-color"]');
                  if (metaThemeColor) {
                    metaThemeColor.setAttribute('content', themeColors[theme]);
                  }
                }

                // Update immediately
                updateThemeColor();

                // Watch for theme changes
                const observer = new MutationObserver(updateThemeColor);
                observer.observe(document.documentElement, {
                  attributes: true,
                  attributeFilter: ['data-theme']
                });
              })();
            `,
          }}
        />
        <Script
          id="sw-register"
          strategy="afterInteractive"
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', function() {
                  navigator.serviceWorker.register('/sw.js').then(
                    function(registration) {
                      console.log('ServiceWorker registration successful');
                    },
                    function(err) {
                      console.log('ServiceWorker registration failed: ', err);
                    }
                  );
                });
              }
            `,
          }}
        />
        {children}
      </body>
    </html>
  );
}
