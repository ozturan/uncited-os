'use client';

import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowUp } from '@fortawesome/free-solid-svg-icons';

interface ScrollToTopButtonProps {
  isMobile: boolean;
  onClick: () => void;
}

export default function ScrollToTopButton({ isMobile, onClick }: ScrollToTopButtonProps) {
  return (
    <button
      onClick={onClick}
      style={{
        position: 'fixed',
        bottom: isMobile ? 'calc(20px + env(safe-area-inset-bottom))' : '32px',
        right: isMobile ? '20px' : '32px',
        width: '48px',
        height: '48px',
        borderRadius: '50%',
        backgroundColor: 'var(--color-accent)',
        color: 'var(--color-accent-text)',
        border: 'none',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        transition: 'all 0.2s ease-out',
        opacity: 1
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'scale(1.1)';
        e.currentTarget.style.backgroundColor = 'var(--color-accent-hover)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'scale(1)';
        e.currentTarget.style.backgroundColor = 'var(--color-accent)';
      }}
      aria-label="Scroll to top"
    >
      <FontAwesomeIcon icon={faArrowUp} className="w-5 h-5" />
    </button>
  );
}
