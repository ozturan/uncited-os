'use client';

interface TypeFilterProps {
    selectedTypes: string[];
    onTypesChange: (types: string[]) => void;
    isOpen: boolean;
    onToggle: () => void;
    variant?: 'grid' | 'inline';
}

const ARTICLE_TYPES = [
    { id: 'Research',   label: 'Research' },
    { id: 'Review',     label: 'Review' },
    { id: 'Commentary', label: 'Commentary' },
    { id: 'News',       label: 'News' },
    { id: 'Letter',     label: 'Letter' },
    { id: 'Editorial',  label: 'Editorial' },
    { id: 'Preprint',   label: 'Preprint' },
    { id: 'Other',      label: 'Other' },
];

const TYPE_BADGE_COLORS: Record<string, { bg: string; text: string }> = {
    Research:   { bg: '#EFF6FF', text: '#1D4ED8' },
    Review:     { bg: '#F0FDF4', text: '#15803D' },
    Preprint:   { bg: '#FFF7ED', text: '#C2410C' },
    News:       { bg: '#FDF2F8', text: '#BE185D' },
    Commentary: { bg: '#F5F3FF', text: '#7C3AED' },
    Editorial:  { bg: '#ECFDF5', text: '#047857' },
    Letter:     { bg: '#FEF3C7', text: '#B45309' },
    Other:      { bg: '#F3F4F6', text: '#4B5563' },
};

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

export default function TypeFilter({
    selectedTypes,
    onTypesChange,
    isOpen,
    onToggle,
    variant = 'grid'
}: TypeFilterProps) {
    const allTypeIds = ARTICLE_TYPES.map(t => t.id);
    const allSelected = allTypeIds.every(id => selectedTypes.includes(id));
    const hasFilter = !allSelected && selectedTypes.length > 0;

    const toggle = (id: string) =>
        onTypesChange(selectedTypes.includes(id)
            ? selectedTypes.filter(t => t !== id)
            : [...selectedTypes, id]);

    return (
        <div style={{ position: 'relative', height: variant === 'grid' ? '100%' : 'auto' }}>
            {/* Mobile grid button */}
            {variant === 'grid' && (
                <button className={`btn-nav ${hasFilter ? 'active' : ''} md:hidden`} style={{ width: '100%', height: '100%' }} onClick={onToggle}>
                    <span className="flex flex-col items-center justify-center">
                        <span>Article Type</span>
                        {hasFilter && <span className="text-[10px] opacity-75">({selectedTypes.length})</span>}
                    </span>
                </button>
            )}
            {/* Mobile inline button */}
            {variant === 'inline' && (
                <button className={`md:hidden btn-nav ${hasFilter ? 'active' : ''}`} onClick={onToggle}>
                    Article Type{hasFilter && <span className="text-[10px] opacity-75 ml-1">({selectedTypes.length})</span>}
                </button>
            )}
            {/* Tablet / Desktop trigger */}
            <button
                className={`hidden md:inline-flex items-center gap-1.5 btn-nav ${hasFilter ? 'active' : ''}`}
                onClick={onToggle}
            >
                Article Type
                {hasFilter && <span className="text-[10px] opacity-75">({selectedTypes.length})</span>}
                <Chevron />
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
                            zIndex: 1000,
                            minWidth: '180px',
                            overflow: 'hidden',
                            padding: '4px 0',
                        }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        {ARTICLE_TYPES.map(type => {
                            const isSelected = selectedTypes.includes(type.id);
                            const badge = TYPE_BADGE_COLORS[type.id];
                            return (
                                <button
                                    key={type.id}
                                    onClick={() => toggle(type.id)}
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
                                    <span style={{
                                        fontSize: '11px',
                                        backgroundColor: badge.bg,
                                        color: badge.text,
                                        padding: '1px 8px',
                                        borderRadius: '9999px',
                                        fontWeight: 500,
                                    }}>
                                        {type.label}
                                    </span>
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
                                    onClick={() => onTypesChange(allTypeIds)}
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

export { ARTICLE_TYPES };
