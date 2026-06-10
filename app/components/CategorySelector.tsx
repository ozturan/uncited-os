'use client';

import { Catalog } from '@/lib/types';

interface CategorySelectorProps {
  catalog: Catalog;
  selectedCategories: string[];
  onCategoriesChange: (categories: string[]) => void;
  isOpen: boolean;
  onToggle: () => void;
  variant?: 'grid' | 'inline';
}

const Check = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const Chevron = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.45 }}>
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

export default function CategorySelector({
  catalog,
  selectedCategories,
  onCategoriesChange,
  isOpen,
  onToggle,
  variant = 'inline'
}: CategorySelectorProps) {
  const allDisciplineIds = catalog.disciplines.map(
    d => d.id || d.name.toLowerCase().replace(/\s+/g, '-')
  );
  const hasFilter = selectedCategories.length > 0 &&
    !allDisciplineIds.every(id => selectedCategories.includes(id));

  const toggle = (id: string) =>
    onCategoriesChange(selectedCategories.includes(id)
      ? selectedCategories.filter(c => c !== id)
      : [...selectedCategories, id]);

  return (
    <div style={{ position: 'relative', width: variant === 'grid' ? '100%' : 'auto', height: variant === 'grid' ? '100%' : 'auto' }}>
      <button
        className={`btn-nav ${variant === 'grid' ? 'w-full h-full' : 'inline-flex items-center gap-1.5'} ${hasFilter ? 'active' : ''}`}
        onClick={onToggle}
      >
        {variant === 'grid' ? (
          <span className="flex flex-col items-center justify-center w-full">
            <span>Categories</span>
            {hasFilter && <span className="text-[10px] opacity-75">({selectedCategories.length})</span>}
          </span>
        ) : (
          <>
            Categories
            {hasFilter && <span className="text-[10px] opacity-75">({selectedCategories.length})</span>}
            <Chevron />
          </>
        )}
      </button>

      {isOpen && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 999 }} onClick={onToggle} />
          <div
            style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              left: 0,
              backgroundColor: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: '8px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
              padding: '4px 0',
              minWidth: '200px',
              maxWidth: '300px',
              maxHeight: '320px',
              overflowY: 'auto',
              zIndex: 1000,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {catalog.disciplines.map(discipline => {
              const disciplineId = discipline.id || discipline.name.toLowerCase().replace(/\s+/g, '-');
              const isSelected = selectedCategories.includes(disciplineId);

              return (
                <button
                  key={disciplineId}
                  onClick={() => toggle(disciplineId)}
                  className={`dropdown-item${isSelected ? ' dropdown-item--selected' : ''}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    width: '100%',
                    padding: '6px 12px',
                    fontSize: '13px',
                    fontWeight: isSelected ? 600 : 400,
                    color: isSelected ? 'var(--color-ink)' : 'var(--color-ink-soft)',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <span>{discipline.name}</span>
                  {isSelected && (
                    <span style={{ color: 'var(--color-ink)', opacity: 0.7, flexShrink: 0 }}>
                      <Check />
                    </span>
                  )}
                </button>
              );
            })}

            {hasFilter && (
              <>
                <div style={{ height: '1px', backgroundColor: 'var(--color-border)', margin: '4px 0' }} />
                <button
                  onClick={() => onCategoriesChange([])}
                  className="dropdown-item"
                  style={{
                    width: '100%', textAlign: 'left', padding: '6px 12px',
                    fontSize: '12px', color: 'var(--color-ink-soft)',
                    border: 'none', cursor: 'pointer',
                  }}
                >
                  Clear filter
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
