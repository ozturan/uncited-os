'use client';

/**
 * ArticleSkeleton - Loading skeleton for article cards
 * Shows animated placeholder while articles are loading
 */
export default function ArticleSkeleton({ count = 5 }: { count?: number }) {
    return (
        <div className="space-y-3 md:space-y-4">
            {Array.from({ length: count }).map((_, index) => (
                <div
                    key={index}
                    className="animate-pulse p-2 md:p-4"
                    style={{
                        backgroundColor: 'var(--color-surface)',
                        border: '1px solid var(--color-border)',
                        borderRadius: '6px'
                    }}
                >
                    <div className="flex flex-col md:flex-row gap-2 md:gap-4">
                        {/* Thumbnail skeleton */}
                        <div
                            className="flex-shrink-0 w-full md:w-[180px] h-[120px]"
                            style={{
                                backgroundColor: 'var(--color-border)',
                                borderRadius: '6px'
                            }}
                        />

                        {/* Content skeleton */}
                        <div className="flex-1 space-y-1.5 md:space-y-3">
                            {/* Title skeleton - 2 lines */}
                            <div className="space-y-2">
                                <div
                                    style={{
                                        height: '14px',
                                        backgroundColor: 'var(--color-border)',
                                        borderRadius: '4px',
                                        width: '90%'
                                    }}
                                />
                                <div
                                    style={{
                                        height: '14px',
                                        backgroundColor: 'var(--color-border)',
                                        borderRadius: '4px',
                                        width: '70%'
                                    }}
                                />
                            </div>

                            {/* Meta skeleton */}
                            <div className="flex items-center gap-2">
                                <div
                                    style={{
                                        height: '10px',
                                        backgroundColor: 'var(--color-border)',
                                        borderRadius: '4px',
                                        width: '80px'
                                    }}
                                />
                                <div
                                    style={{
                                        height: '10px',
                                        backgroundColor: 'var(--color-border)',
                                        borderRadius: '4px',
                                        width: '60px'
                                    }}
                                />
                                <div
                                    style={{
                                        height: '10px',
                                        backgroundColor: 'var(--color-border)',
                                        borderRadius: '4px',
                                        width: '100px'
                                    }}
                                />
                            </div>

                            {/* Abstract skeleton - 2 lines */}
                            <div className="space-y-2">
                                <div
                                    style={{
                                        height: '10px',
                                        backgroundColor: 'var(--color-border)',
                                        borderRadius: '4px',
                                        width: '100%'
                                    }}
                                />
                                <div
                                    style={{
                                        height: '10px',
                                        backgroundColor: 'var(--color-border)',
                                        borderRadius: '4px',
                                        width: '85%'
                                    }}
                                />
                            </div>
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
}
