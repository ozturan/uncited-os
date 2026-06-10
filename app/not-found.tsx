'use client';

import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen flex flex-col bg-white">
      <div style={{ height: '80px' }} />
      <main className="flex-1 py-16 md:py-24">
        <div className="max-w-4xl mx-auto px-6 md:px-12">
          <h1 className="text-4xl md:text-5xl mb-8" style={{
            fontWeight: 300,
            color: '#1a1a1a',
            letterSpacing: '-0.02em'
          }}>
            Page Not Found
          </h1>

          <div className="space-y-8" style={{ color: '#525252', lineHeight: 1.8, fontWeight: 400 }}>
            <section>
              <p className="mb-4">
                The page you're looking for doesn't exist or has been moved.
              </p>
              <p>
                Return to the{' '}
                <Link
                  href="/"
                  style={{
                    color: 'inherit',
                    textDecoration: 'underline',
                    textDecorationColor: 'var(--brand-underline-blue)',
                    textUnderlineOffset: '4px',
                    padding: '2px 4px',
                    borderRadius: '4px',
                    transition: 'background-color 120ms ease, color 120ms ease',
                    display: 'inline-block'
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--brand-underline-blue)'; e.currentTarget.style.color = '#ffffff'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = 'inherit'; }}
                >
                  homepage
                </Link>
                {' '}to continue.
              </p>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
