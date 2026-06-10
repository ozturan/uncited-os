'use client';

import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSearch } from '@fortawesome/free-solid-svg-icons';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export default function SearchBar({ value, onChange, placeholder = "Search title or abstract..." }: SearchBarProps) {
  return (
    <div className="relative">
      <FontAwesomeIcon
        icon={faSearch}
        className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 opacity-40"
        style={{ color: 'var(--color-ink-soft)' }}
        aria-hidden
      />
      <input
        type="search"
        placeholder={placeholder}
        className="w-full pl-10 pr-4 py-2 md:py-1.5 text-sm transition-all border"
        style={{
          borderColor: 'var(--color-border)',
          borderRadius: '6px',
          fontSize: '16px',
          color: 'var(--color-ink)',
          backgroundColor: 'var(--color-surface)',
          fontWeight: 400
        }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = 'var(--color-accent)';
          e.currentTarget.style.boxShadow = '0 0 0 3px rgba(8, 72, 216, 0.1)';
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = 'var(--color-border)';
          e.currentTarget.style.boxShadow = 'none';
        }}
      />
      {value.length > 0 && (
        <button
          onClick={() => onChange('')}
          className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 flex items-center justify-center opacity-40 hover:opacity-60"
          style={{ color: 'var(--color-ink-soft)' }}
          title="Clear search"
          aria-label="Clear search"
        >
          ×
        </button>
      )}
    </div>
  );
}
